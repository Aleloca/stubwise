import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { clientIpHeaders, signInFromUi, signInWithRequest } from "./second-factor";
import { addPrfAuthenticator } from "./virtual-authenticator";

/*
 * La cassaforte delle credenziali contro lo stack reale (23 ott 2026), con
 * passkey VERE dal punto di vista del browser: l'autenticatore virtuale di
 * Chromium con la PRF (`virtual-authenticator.ts`), quindi sblocco,
 * creazione delle chiavi e cifratura passano dal codice di produzione e da
 * `@stubwise/vault-crypto`, senza doppi.
 *
 * Il percorso: l'admin registra una passkey, attiva la cassaforte (il kit si
 * vede una volta), crea una credenziale e la mostra, la condivide con un
 * ruolo. Un utente invitato con quel ruolo crea la sua chiave e resta in
 * attesa finché l'admin non lo conferma da «Accessi da confermare»
 * (confrontando l'impronta che l'utente vede della propria chiave); poi la
 * mostra. Una conferma senza la prova della chiave di chi conferma (un login
 * rubato) è respinta. Tolto il ruolo dai lettori, non la vede più. Infine
 * l'admin rigenera il kit di recupero.
 *
 * Stack condiviso con gli altri spec (vedi `roles-flow.spec.ts`): entra con
 * l'admin che `core-flows` ha creato, o fa il primo setup. La cassaforte si
 * attiva UNA volta per istanza, e lo stack nasce vuoto a ogni run.
 */

const ADMIN_EMAIL = "ada@example.com";
const ADMIN_PASSWORD = "password-sicura-e2e";
const USER_PASSWORD = "password-sicura-e2e-utente";

test.describe.configure({ mode: "serial" });

const suffix = Date.now().toString(36);
const projectName = `Vault ${suffix}`;
const userEmail = `vault-reader-${suffix}@example.com`;
const SERVICE = "Hetzner";
const LABEL = "Main account";
const CREDENTIAL = `${SERVICE} · ${LABEL}`;
const PASSWORD = `s3cret-${suffix}!`;

let adminContext: BrowserContext;
let admin: Page;
let userContext: BrowserContext;
let user: Page;
let projectId: string;
/** L'impronta che l'utente vede della PROPRIA chiave, da confrontare con quella dell'admin. */
let userFingerprint: string;

/** Entra come admin: primo setup se l'istanza è vergine, login altrimenti. */
async function signInAdmin(request: APIRequestContext): Promise<void> {
  const status = await request.get("/api/auth/setup");
  const { needed } = (await status.json()) as { needed: boolean };
  if (needed) {
    const setup = await request.post("/api/auth/setup", {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(setup.ok()).toBe(true);
  }
  await signInWithRequest(request, ADMIN_EMAIL, ADMIN_PASSWORD);
}

/** Impostazioni → Sicurezza: registra una passkey (l'autenticatore virtuale del contesto). */
async function registerPasskey(page: Page, name: string): Promise<void> {
  await page.goto("/settings/security");
  await page.getByLabel("Passkey name").fill(name);
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByRole("button", { name: `Rename passkey ${name}` })).toBeVisible();
}

/** Il dialogo dello sblocco: la passkey virtuale risponde da sola, e il dialogo si chiude. */
async function usePasskey(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Open the vault" });
  await dialog.getByRole("button", { name: "Use passkey" }).click();
  await expect(dialog).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext(clientIpHeaders());
  admin = await adminContext.newPage();
  await addPrfAuthenticator(adminContext, admin);
  // `page.request` condivide i cookie della pagina: la sessione vale per entrambi.
  await signInAdmin(admin.request);

  const project = await admin.request.post("/api/projects", { data: { name: projectName } });
  expect(project.status()).toBe(201);
  projectId = ((await project.json()) as { id: string }).id;

  // L'utente entra nel progetto col preset Developer, dall'invito: nessun
  // permesso sulle credenziali, solo il ruolo con cui gliele si condivide.
  const roles = await admin.request.get("/api/roles?scope=project");
  expect(roles.ok()).toBe(true);
  const developer = ((await roles.json()) as { id: string; presetKey: string | null }[]).find(
    (role) => role.presetKey === "developer",
  );
  expect(developer).toBeDefined();
  const invite = await admin.request.post("/api/auth/invites", {
    data: { email: userEmail, projects: [{ projectId, roleId: developer!.id }] },
  });
  expect(invite.status()).toBe(201);
  const { token } = (await invite.json()) as { token: string };
  const anonymous = await browser.newContext(clientIpHeaders());
  const registered = await anonymous.request.post("/api/auth/register", {
    data: { token, email: userEmail, password: USER_PASSWORD },
  });
  expect(registered.ok()).toBe(true);
  await anonymous.close();

  userContext = await browser.newContext(clientIpHeaders());
  user = await userContext.newPage();
  await addPrfAuthenticator(userContext, user);
});

test.afterAll(async () => {
  await adminContext?.close();
  await userContext?.close();
});

test("l'admin attiva la cassaforte: il kit si vede una volta, poi la sua chiave è aperta", async () => {
  await registerPasskey(admin, "Admin laptop");

  await admin.goto("/settings/vault");
  await admin.getByRole("button", { name: "Generate the recovery kit" }).click();
  const kit = admin.getByTestId("recovery-kit-text");
  await expect(kit).toBeVisible();
  expect((await kit.innerText()).trim().length).toBeGreaterThan(20);

  const activate = admin.getByRole("button", { name: "Activate the vault" });
  await expect(activate).toBeDisabled();
  await admin.getByLabel("I printed/saved the kit").check();
  await activate.click();

  await expect(admin.getByText("The vault is open in this tab.")).toBeVisible();
  await expect(kit).toHaveCount(0);

  const status = await admin.request.get("/api/vault/status");
  const body = (await status.json()) as { activated: boolean; myKey: { status: string } | null };
  expect(body.activated).toBe(true);
  // La prima chiave dell'istanza (l'admin che attiva) nasce confermata.
  expect(body.myKey?.status).toBe("confirmed");
});

test("l'admin crea una credenziale, la mostra e la condivide col ruolo", async () => {
  await admin.goto(`/projects/${projectId}`);
  const section = admin.getByRole("region", { name: "Credentials" });
  await section.getByRole("button", { name: "New credential" }).click();
  const form = section.getByRole("form", { name: "New credential" });
  await form.getByLabel("Service").fill(SERVICE);
  await form.getByLabel("Label").fill(LABEL);
  await form.getByLabel("Username").fill("ops@example.com");
  await form.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await form.getByRole("button", { name: "Save" }).click();

  const row = section.getByRole("listitem", { name: CREDENTIAL });
  await expect(row).toBeVisible();
  // La password non è in pagina finché nessuno la chiede.
  await expect(admin.getByText(PASSWORD)).toHaveCount(0);

  // Pagina ricaricata: la cassaforte è chiusa, «Mostra» chiede la passkey.
  await row.getByRole("button", { name: `Show the password of ${CREDENTIAL}` }).click();
  await usePasskey(admin);
  await expect(row.getByLabel(`Password of ${CREDENTIAL}`, { exact: true })).toHaveText(PASSWORD);

  await row.getByRole("button", { name: `Readers of ${CREDENTIAL}` }).click();
  const readers = row.getByRole("region", { name: `Readers of ${CREDENTIAL}` });
  await readers.getByLabel("Share with").selectOption({ label: "All Developer" });
  await readers.getByRole("button", { name: "Share", exact: true }).click();

  await expect(readers.getByText("role Developer")).toBeVisible();
  // L'utente non ha ancora una chiave: legge «in attesa», non riceve nulla.
  const waiting = readers.getByRole("listitem").filter({ hasText: userEmail });
  await expect(waiting.getByText("waiting: no vault key yet")).toBeVisible();
});

test("l'utente invitato col ruolo crea la sua chiave e resta in attesa", async () => {
  // Primo login dell'utente: password, poi la configurazione del secondo fattore.
  await signInFromUi(user, userEmail, USER_PASSWORD);
  await registerPasskey(user, "User phone");

  await user.goto("/credentials");
  await user.getByRole("button", { name: "Create your key" }).click();
  await usePasskey(user);

  await expect(user.getByText(/Your vault key is waiting for confirmation/)).toBeVisible();
  // La propria impronta, dalla chiave aperta nella scheda.
  const own = user.getByTestId("own-key-fingerprint");
  await expect(own).toHaveText(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  userFingerprint = (await own.innerText()).trim();
  const row = user.getByRole("listitem", { name: CREDENTIAL });
  await expect(row.getByText("Waiting for confirmation")).toBeVisible();
  await expect(row.getByRole("button", { name: /Show the password/ })).toHaveCount(0);
});

test("una conferma senza la prova della chiave di chi conferma è respinta (login rubato)", async () => {
  const pending = (await (await admin.request.get("/api/vault/pending")).json()) as {
    items: { personKey: { id: string }; credentials: { id: string; keyVersion: string }[] }[];
  };
  const entry = pending.items[0]!;
  const copies = entry.credentials.map((c) => ({
    credentialId: c.id,
    keyVersion: c.keyVersion,
    wrappedKey: JSON.stringify({ v: 1, epk: "AA", iv: "AA", ct: "AA" }),
  }));
  const url = `/api/vault/pending/${entry.personKey.id}/confirm`;
  // Senza prova il corpo non valida; con una prova inventata → 403, e nulla cambia.
  expect((await admin.request.post(url, { data: { copies } })).status()).toBe(400);
  const forged = await admin.request.post(url, {
    data: { copies, actorProof: { challengeId: crypto.randomUUID(), proof: "A".repeat(43) } },
  });
  expect(forged.status()).toBe(403);
  expect(((await forged.json()) as { code: string }).code).toBe("vault_proof_invalid");
  const after = (await (await admin.request.get("/api/vault/pending")).json()) as { items: unknown[] };
  expect(after.items).toHaveLength(1);
});

test("l'admin conferma l'accesso da «Accessi da confermare»", async () => {
  await admin.goto("/credentials");
  const panel = admin.getByRole("region", { name: "Access to confirm" });
  const person = panel.getByRole("group", { name: userEmail });
  await expect(person.getByText("1 credential")).toBeVisible();
  // L'impronta che l'admin vede è quella che l'utente vede della sua chiave.
  await expect(person.getByText(userFingerprint)).toBeVisible();
  await person.getByRole("button", { name: `Confirm ${userEmail}` }).click();
  await person.getByRole("button", { name: "Yes, I checked: confirm" }).click();
  // La conferma apre la propria copia: la cassaforte, chiusa dal ricaricamento, chiede la passkey.
  await usePasskey(admin);
  // Confermata l'ultima persona in attesa, il pannello sparisce (e con lui
  // l'esito «… now reads 1 credential.», che vive nel suo stato): l'esito
  // si verifica sul server e, nel test dopo, dal lato dell'utente.
  await expect(panel).toHaveCount(0);
  const pending = await admin.request.get("/api/vault/pending");
  expect(((await pending.json()) as { items: unknown[] }).items).toHaveLength(0);
});

test("l'utente confermato mostra la password", async () => {
  await user.goto("/credentials");
  await expect(user.getByText(/Your vault key is waiting for confirmation/)).toHaveCount(0);
  const row = user.getByRole("listitem", { name: CREDENTIAL });
  await row.getByRole("button", { name: `Show the password of ${CREDENTIAL}` }).click();
  await usePasskey(user);
  await expect(row.getByLabel(`Password of ${CREDENTIAL}`, { exact: true })).toHaveText(PASSWORD);
});

test("tolto il ruolo dai lettori, l'utente non la vede più", async () => {
  await admin.goto(`/projects/${projectId}`);
  const row = admin.getByRole("listitem", { name: CREDENTIAL });
  await row.getByRole("button", { name: `Readers of ${CREDENTIAL}` }).click();
  const readers = row.getByRole("region", { name: `Readers of ${CREDENTIAL}` });
  await readers.getByRole("button", { name: "Remove role Developer" }).click();
  // Togliere un lettore vuole la prova della propria chiave: la cassaforte, chiusa dal ricaricamento, chiede la passkey.
  await usePasskey(admin);
  await expect(
    readers.getByText("role Developer no longer reads this credential", { exact: false }),
  ).toBeVisible();

  const list = await admin.request.get(`/api/projects/${projectId}/credentials`);
  const credentialId = ((await list.json()) as { items: { id: string }[] }).items[0]!.id;

  await user.goto("/credentials");
  await expect(user.getByText("You cannot read any credential yet.")).toBeVisible();
  await expect(user.getByRole("listitem", { name: CREDENTIAL })).toHaveCount(0);
  // E il server non gliela dà più, nemmeno chiedendola direttamente.
  const reveal = await user.request.post(`/api/credentials/${credentialId}/reveal`, {
    data: { action: "show" },
  });
  expect(reveal.status()).toBe(404);
});

test("l'admin rigenera il kit di recupero: kit nuovo mostrato una volta, il vecchio non vale più", async () => {
  const before = (await (await admin.request.get("/api/vault/status")).json()) as { activated: boolean };
  expect(before.activated).toBe(true);
  await admin.goto("/settings/vault");
  await admin.getByRole("button", { name: "Regenerate the recovery kit" }).click();
  await usePasskey(admin);
  const kit = admin.getByTestId("recovery-kit-text");
  await expect(kit).toBeVisible();
  await expect(admin.getByText(/the old kit stops working/i)).toBeVisible();
  const replace = admin.getByRole("button", { name: "Replace the recovery kit" });
  await expect(replace).toBeDisabled();
  await admin.getByLabel("I printed/saved the new kit").check();
  await replace.click();
  await expect(admin.getByText(/The recovery kit was replaced/)).toBeVisible();
  await expect(kit).toHaveCount(0);
});
