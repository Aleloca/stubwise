import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import postgres from "postgres";
import {
  clientIpHeaders,
  enrollFromUi,
  nextTotpCode,
  signInWithRequest,
  stackDatabaseUrl,
  verifyFromUi,
} from "./second-factor";

/*
 * Il secondo fattore contro lo stack reale (23 ott 2026): primo login con la
 * configurazione obbligatoria dell'app e i codici di riserva, logout e login
 * col codice, riconferma prima di un'azione sensibile.
 *
 * Lo stack è condiviso con gli altri spec della run: l'admin c'è già o lo si
 * crea (`signInWithRequest` passa dal secondo fattore anche lui), l'utente di
 * questo spec è nuovo e ha un suffisso unico.
 *
 * La riconferma scatta su un secondo fattore più vecchio di 10 minuti, e
 * l'ora che conta è quella del SERVER: `page.clock` sposta solo il browser.
 * Il test invecchia quindi `sessions.second_factor_at` direttamente nel
 * database dello stack (l'URL lo scrive `start-stack.mjs`), invece di
 * aspettare 10 minuti o aprire una rotta solo per i test.
 */

const ADMIN_EMAIL = "ada@example.com";
const ADMIN_PASSWORD = "password-sicura-e2e";
const USER_PASSWORD = "password-sicura-e2e-2fa";

test.describe.configure({ mode: "serial" });

const suffix = Date.now().toString(36);
const userEmail = `totp-${suffix}@example.com`;

let context: BrowserContext;
let page: Page;

/** Invito dell'admin e registrazione via API, senza aprire sessioni nel contesto del test. */
async function registerUser(browser: Browser): Promise<void> {
  const admin = await browser.newContext(clientIpHeaders());
  const status = await admin.request.get("/api/auth/setup");
  if (((await status.json()) as { needed: boolean }).needed) {
    const setup = await admin.request.post("/api/auth/setup", {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(setup.ok()).toBe(true);
  }
  await signInWithRequest(admin.request, ADMIN_EMAIL, ADMIN_PASSWORD);
  const invite = await admin.request.post("/api/auth/invites", { data: { email: userEmail } });
  expect(invite.status()).toBe(201);
  const { token } = (await invite.json()) as { token: string };
  await admin.close();

  const anonymous = await browser.newContext(clientIpHeaders());
  const registered = await anonymous.request.post("/api/auth/register", {
    data: { token, email: userEmail, password: USER_PASSWORD },
  });
  expect(registered.ok()).toBe(true);
  await anonymous.close();
}

async function submitPassword(): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(userEmail);
  await page.getByLabel("Password").fill(USER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.beforeAll(async ({ browser }) => {
  await registerUser(browser);
  context = await browser.newContext(clientIpHeaders());
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

test("primo login: configurazione obbligatoria, codici di riserva, poi dentro", async () => {
  await submitPassword();
  await expect(page).toHaveURL(/\/login\/second-factor$/);
  await expect(page.getByRole("heading", { name: "Set up two-step verification" })).toBeVisible();

  // La sessione è parziale finché il secondo fattore non è configurato:
  // una pagina protetta riporta qui, non dentro.
  expect((await page.request.get("/api/auth/me")).status()).toBe(401);

  const backupCodes = await enrollFromUi(page, userEmail);
  expect(new Set(backupCodes).size).toBe(10);

  await expect(page).toHaveURL(/\/tickets$/);
  expect((await page.request.get("/api/auth/me")).status()).toBe(200);
});

test("logout e login: il secondo passo chiede il codice dell'app", async () => {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await submitPassword();
  await expect(page).toHaveURL(/\/login\/second-factor$/);
  await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();

  // Un codice sbagliato non apre niente: si resta al secondo passo.
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login\/second-factor$/);

  await verifyFromUi(page, userEmail);
  await expect(page).toHaveURL(/\/tickets$/);
});

test("creare un token personale con un secondo fattore di più di 10 minuti fa chiede la riconferma", async () => {
  // Il codice della riconferma vuole un passo TOTP non ancora usato: dopo
  // configurazione e login ravvicinati `nextTotpCode` può aspettare fino a un
  // passo intero (30 s), oltre al resto del test.
  test.setTimeout(90_000);
  const sql = postgres(stackDatabaseUrl(), { max: 1 });
  try {
    await sql`
      update sessions set second_factor_at = now() - interval '11 minutes'
      where user_id = (select id from users where email = ${userEmail}) and stage = 'full'
    `;
  } finally {
    await sql.end();
  }

  await page.goto("/settings/access-tokens");
  await page.getByLabel("Name").fill("Token e2e");
  await page.getByRole("button", { name: "Create token" }).click();

  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Authenticator code").fill(await nextTotpCode(userEmail));
  await dialog.getByRole("button", { name: "Confirm" }).click();

  // Riconfermato: la richiesta riparte da sola e il token nasce.
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Token created")).toBeVisible();
});
