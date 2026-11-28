import { expect, test, type APIRequestContext, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { PRF_INPUT, generatePersonKeyPair, generateRecoveryKit, sealPrivateKey } from "@stubwise/vault-crypto";
import { ADMIN_EMAIL, ADMIN_PASSWORD, ensureAdmin } from "./admin";
import { clientIpHeaders, nextTotpCode, signInWithRequest } from "./second-factor";

/*
 * La cassaforte nella nuova app nel browser (fase 1, #144), sullo stack vero:
 * una passkey registrata DALLA UI (Preferenze → Security) su un
 * autenticatore virtuale di Chromium con la PRF, la cerimonia `vault` e la
 * prima chiave (via API: la pagina che la crea dalla UI è la fase 2), una
 * credenziale creata dalla UI (cifrata nel worker), poi lo sblocco con la
 * passkey e «Show» dalla UI di `/app`.
 *
 * La cerimonia della prima chiave gira nel browser (la PRF la dà solo
 * l'autenticatore), ma su `/health`, fuori dall'app: la pagina di `/app`
 * congela le primitive della passkey al boot, ed è giusto così. La stessa
 * origine, quindi la stessa passkey e lo stesso `rpId`.
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

test("la cerimonia `vault` e la prima chiave dell'admin (via API, la PRF dal browser)", async () => {
  const request = context.request;
  // L'istanza: la cassaforte si attiva con la sola pubblica di un kit di recupero.
  const kit = await generateRecoveryKit();
  const activate = await request.post("/api/vault/activate", { data: { recoveryPublicKey: kit.publicKey } });
  expect(activate.ok(), await activate.text()).toBe(true);

  // La cerimonia dello sblocco: le opzioni del server (`purpose: "vault"`, il salt PRF locale).
  const options = (await (await request.post("/api/me/security/reauth/passkey/options", { data: { purpose: "vault" } })).json()) as {
    challenge: string;
    allowCredentials: { id: string }[];
    rpId?: string;
    extensions?: { prf?: { eval?: { first?: string } } };
  };
  expect(options.extensions?.prf?.eval?.first).toBe(Buffer.from(PRF_INPUT).toString("base64url"));
  await page.goto("/health");
  const touched = await page.evaluate(async (o) => {
    const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    const out = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: b64(o.challenge),
        ...(o.rpId ? { rpId: o.rpId } : {}),
        allowCredentials: o.allowCredentials.map((c) => ({ type: "public-key" as const, id: b64(c.id) })),
        userVerification: "preferred",
        extensions: { prf: { eval: { first: b64(o.extensions!.prf!.eval!.first!) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
    const r = cred.response as AuthenticatorAssertionResponse;
    const prf = (cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
    return {
      credentialId: cred.id,
      prf: prf ? out(prf) : null,
      assertion: {
        id: cred.id,
        rawId: out(cred.rawId),
        type: cred.type,
        response: {
          authenticatorData: out(r.authenticatorData),
          clientDataJSON: out(r.clientDataJSON),
          signature: out(r.signature),
          ...(r.userHandle ? { userHandle: out(r.userHandle) } : {}),
        },
        clientExtensionResults: {},
      },
    };
  }, options);
  expect(touched.prf, "l'autenticatore virtuale dà la PRF").not.toBeNull();
  const verify = await request.post("/api/me/security/reauth/passkey/verify", { data: { response: touched.assertion } });
  expect(verify.status(), await verify.text()).toBe(204);

  // La chiave: la coppia nasce qui, la privata si sigilla con la PRF della passkey usata.
  const status = (await (await request.get("/api/vault/status")).json()) as { passkeys: { passkeyId: string; credentialIdB64url: string }[] };
  const passkey = status.passkeys.find((p) => p.credentialIdB64url === touched.credentialId);
  expect(passkey, "la passkey registrata dalla UI").toBeDefined();
  const pair = await generatePersonKeyPair();
  const prf = Uint8Array.from(Buffer.from(touched.prf!, "base64url"));
  const sealedPrivateKey = await sealPrivateKey(prf.buffer, pair.privateKeyPkcs8, pair.publicKey);
  pair.privateKeyPkcs8.fill(0);
  const created = await request.post("/api/vault/keys", {
    data: { publicKey: pair.publicKey, seals: [{ passkeyId: passkey!.passkeyId, sealedPrivateKey }], device: "Chromium E2E" },
  });
  expect(created.status(), await created.text()).toBe(201);
  // Il primo admin, che ha attivato: la sua chiave nasce confermata.
  expect(((await created.json()) as { status: string }).status).toBe("confirmed");
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
