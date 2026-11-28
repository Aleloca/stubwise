import { expect, test, type APIRequestContext, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, ensureAdmin } from "./admin";
import { clientIpHeaders, nextTotpCode, signInWithRequest } from "./second-factor";

/*
 * La cassaforte nella nuova app nel browser (fase 1, #144), sullo stack vero:
 * una passkey registrata DALLA UI (Preferenze → Security) su un
 * autenticatore virtuale di Chromium con la PRF; l'attivazione e la prima
 * chiave dalla pagina a sé della cassaforte (fase 2, `/app/vault/#/setup`,
 * con la sua CSP: il kit e la chiave nascono nel worker); una credenziale
 * creata dalla UI (cifrata nel worker), poi lo sblocco con la passkey e
 * «Show» dalla UI di `/app`.
 */

const PROJECT_CODE = "VAULT";
const SERVICE = "Pannello del fornitore";
const USERNAME = "ada.fornitore";
const PASSWORD = `Kx4!pa-${Date.now().toString(36)}`;

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let cdp: CDPSession;
let authenticatorId: string;

/** La riconferma, se il dialogo compare: il codice dell'app (il campo si invia da sé). */
async function confirmIfAsked(): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  if (await dialog.isVisible().catch(() => false)) await dialog.getByLabel("Code").fill(await nextTotpCode(ADMIN_EMAIL));
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext(clientIpHeaders());
  page = await context.newPage();
  // L'autenticatore virtuale è della pagina (del suo target CDP): tutta la spec usa questa.
  cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  }));
  const request: APIRequestContext = context.request;
  await ensureAdmin(request);
  // Il login via API (i cookie restano nel contesto, la pagina li usa): la UI del login la prova `app.spec.ts`.
  await signInWithRequest(request, ADMIN_EMAIL, ADMIN_PASSWORD);
  const project = await request.post("/api/projects", { data: { name: "Fornitori", code: PROJECT_CODE } });
  expect(project.status(), await project.text()).toBe(201);
});

test.afterAll(async () => {
  await context.close();
});

test("una passkey si registra dalla UI (Preferenze → Security), con la PRF dell'autenticatore", async () => {
  await page.goto("/app/#/preferences/security");
  await page.getByRole("button", { name: "Add passkey" }).click();
  await page.getByLabel("Name this passkey").fill("Chromium E2E");
  await page.getByRole("button", { name: "Continue" }).click();
  await confirmIfAsked();
  await expect(page.getByText("Passkey “Chromium E2E” added.")).toBeVisible();
  // La credenziale è nell'autenticatore della pagina.
  const { credentials } = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })) as { credentials: unknown[] };
  expect(credentials).toHaveLength(1);
});

test("l'attivazione e la prima chiave dalla pagina a sé della cassaforte (/app/vault/, la sua CSP)", async () => {
  // Una navigazione completa, come dalla barra: un documento suo, con la sua CSP e la sua COOP.
  const response = await page.goto("/app/vault/#/setup");
  const headers = response!.headers();
  expect(headers["content-security-policy"]).toContain("default-src 'none'");
  expect(headers["content-security-policy"]).toContain("trusted-types stubwise-vault-worker");
  expect(headers["cross-origin-opener-policy"]).toBe("noopener-allow-popups");
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Trusted Type/i.test(m.text())) violations.push(m.text());
  });

  await page.getByRole("button", { name: "Generate the recovery kit" }).click();
  // Il kit nasce nel worker e si mostra una volta.
  await expect(page.locator("pre[data-recovery-kit]")).toHaveText(/^[A-Z2-7]{5}(-[A-Z2-7]{1,5})+$/);
  await page.getByRole("checkbox", { name: "I printed/saved the kit" }).check();
  await page.getByRole("button", { name: "Activate the vault" }).click();
  // La riconferma, se la pagina la chiede: la passkey (l'autenticatore la dà da sé).
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(page.getByText("The vault is active on this instance.").or(confirm)).toBeVisible();
  if (await confirm.isVisible()) await confirm.getByRole("button", { name: "Confirm" }).click();

  // Il primo admin, che ha attivato: la sua chiave nasce confermata, il kit è sparito.
  await expect(page.getByText("The vault is active on this instance.")).toBeVisible();
  await expect(page.getByText(/Your vault key is ready|You have a vault key\./)).toBeVisible();
  await expect(page.locator("pre[data-recovery-kit]")).toHaveCount(0);
  expect(violations).toEqual([]);

  // Dal server: attiva, e la chiave della persona confermata con un sigillo della passkey.
  const status = (await (await context.request.get("/api/vault/status")).json()) as {
    activated: boolean;
    myKey: { status: string } | null;
    seals: unknown[];
  };
  expect(status.activated).toBe(true);
  expect(status.myKey?.status).toBe("confirmed");
  expect(status.seals).toHaveLength(1);
});

test("una credenziale si crea dalla UI (la cifra il worker, a cassaforte chiusa)", async () => {
  await page.goto(`/app/#/p/${PROJECT_CODE}/credentials`);
  await expect(page.getByText("Locked.")).toBeVisible();
  await page.getByRole("button", { name: "New credential" }).click();
  await page.getByLabel("Service").fill(SERVICE);
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Credential saved.")).toBeVisible();
  await expect(page.getByText(SERVICE).first()).toBeVisible();
});

test("lo sblocco con la passkey e «Show» dalla UI di /app; «Lock» la richiude e la password sparisce", async () => {
  await page.reload();
  await expect(page.getByText("Locked.")).toBeVisible();
  await page.getByRole("button", { name: "Open with passkey" }).click();
  await expect(page.getByText("Open · closes after 15 minutes without use")).toBeVisible();
  // La riga dell'elenco (il dettaglio aperto ha il suo «Show»).
  await page.getByRole("button", { name: `Show the password of ${SERVICE}` }).first().click();
  await expect(page.getByText(PASSWORD).first()).toBeVisible();
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page.getByText("Locked.")).toBeVisible();
  await expect(page.getByText(PASSWORD)).toHaveCount(0);
});
