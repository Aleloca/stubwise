import { randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { generateSync } from "otplib";

/*
 * Il secondo fattore negli e2e: ogni login (UI o `request`) passa dal codice
 * dell'app, e il primo login di un account dalla sua configurazione. Il
 * segreto lo legge dalla pagina (il testo «inserisci a mano» accanto al QR) o
 * dalla risposta di `enroll`, e i codici li calcola `otplib` come farebbe
 * l'app di autenticazione.
 *
 * I segreti stanno in un file della run, non in memoria: gli spec possono
 * girare in processi diversi (Playwright ricrea il worker dopo un errore) e
 * `roles-flow` entra con l'admin che `core-flows` ha configurato. Il file lo
 * ripulisce `start-stack.mjs` a ogni avvio dello stack.
 */

/** Stessa cartella di `start-stack.mjs`. */
const STACK_DIR = path.join(os.tmpdir(), "stubwise-e2e");
const SECRETS_FILE = path.join(STACK_DIR, "totp.json");

const TOTP_PERIOD = 30;

interface StoredAccount {
  secret: string;
  /** L'ultimo passo usato: il server rifiuta un passo già usato (anti-replay). */
  lastStep: number;
  backupCodes: string[];
}

function readAccounts(): Record<string, StoredAccount> {
  if (!existsSync(SECRETS_FILE)) return {};
  return JSON.parse(readFileSync(SECRETS_FILE, "utf8")) as Record<string, StoredAccount>;
}

function writeAccount(email: string, account: StoredAccount): void {
  writeFileSync(SECRETS_FILE, JSON.stringify({ ...readAccounts(), [email]: account }));
}

function storedAccount(email: string): StoredAccount {
  const account = readAccounts()[email];
  if (!account) throw new Error(`Nessun secondo fattore registrato per ${email}`);
  return account;
}

/** L'URL del Postgres dello stack, scritto da `start-stack.mjs`. */
export function stackDatabaseUrl(): string {
  const stack = JSON.parse(readFileSync(path.join(STACK_DIR, "stack.json"), "utf8")) as {
    databaseUrl: string;
  };
  return stack.databaseUrl;
}

/**
 * Un IP di client nuovo per un contesto del browser (lo stack ha
 * `TRUST_PROXY`): il tetto di 10 tentativi al minuto per IP su login e
 * secondo fattore resta per contesto, invece di sommare l'intera run.
 */
export function clientIpHeaders(): { extraHTTPHeaders: Record<string, string> } {
  const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  return { extraHTTPHeaders: { "x-forwarded-for": ip } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Un codice dell'app ancora buono per `email`: il passo corrente, o il
 * successivo se il corrente è già stato usato (il server tollera ±1 passo).
 * Se anche quello è usato, aspetta il passo dopo.
 */
export async function nextTotpCode(email: string): Promise<string> {
  const account = storedAccount(email);
  for (;;) {
    const current = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
    const step = Math.max(current, account.lastStep + 1);
    if (step <= current + 1) {
      writeAccount(email, { ...account, lastStep: step });
      return generateSync({
        secret: account.secret,
        algorithm: "sha1",
        digits: 6,
        period: TOTP_PERIOD,
        epoch: step * TOTP_PERIOD,
      });
    }
    await sleep(1_000);
  }
}

/** Un codice di riserva non ancora usato (e da qui in poi segnato come usato). */
export function takeBackupCode(email: string): string {
  const account = storedAccount(email);
  const [code, ...rest] = account.backupCodes;
  if (!code) throw new Error(`Codici di riserva finiti per ${email}`);
  writeAccount(email, { ...account, backupCodes: rest });
  return code;
}

/** Registra il segreto appena confermato: il codice di conferma ha usato il passo corrente. */
function registerAccount(email: string, secret: string, backupCodes: string[]): void {
  writeAccount(email, { secret, lastStep: 0, backupCodes });
}

/**
 * Configurazione dalla UI (`/login/second-factor`, stadio `enrollment`): legge
 * il segreto in testo, conferma il primo codice, tiene i codici di riserva,
 * spunta «I saved the codes» e prosegue. Restituisce i codici di riserva.
 */
export async function enrollFromUi(page: Page, email: string): Promise<string[]> {
  await expect(page).toHaveURL(/\/login\/second-factor$/);
  const secret = (
    await page
      .getByText("Or enter this key by hand")
      .locator("xpath=following-sibling::code")
      .innerText()
  ).trim();
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  registerAccount(email, secret, []);

  await page.getByLabel("Authenticator code").fill(await nextTotpCode(email));
  await page.getByRole("button", { name: "Confirm" }).click();

  const list = page.getByRole("list").filter({ has: page.getByRole("listitem") });
  await expect(list.getByRole("listitem")).toHaveCount(10);
  const backupCodes = (await list.getByRole("listitem").allInnerTexts()).map((code) => code.trim());
  writeAccount(email, { ...storedAccount(email), backupCodes });

  const continueButton = page.getByRole("button", { name: "Continue" });
  await expect(continueButton).toBeDisabled();
  await page.getByLabel("I saved the codes").check();
  await continueButton.click();
  return backupCodes;
}

/** Secondo passo dalla UI (stadio `second_factor`), col codice dell'app. */
export async function verifyFromUi(page: Page, email: string): Promise<void> {
  await expect(page).toHaveURL(/\/login\/second-factor$/);
  await page.getByLabel("Authenticator code").fill(await nextTotpCode(email));
  await page.getByRole("button", { name: "Verify" }).click();
}

/** Login dalla UI, password e secondo passo (configurazione al primo login). */
export async function signInFromUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login\/second-factor$/);
  if (readAccounts()[email]) await verifyFromUi(page, email);
  else await enrollFromUi(page, email);
  await expect(page).toHaveURL(/\/tickets$/);
}

/**
 * Login via API con `request` (i cookie restano nel contesto): password,
 * poi il codice — o, al primo login, la configurazione via `enroll`.
 */
export async function signInWithRequest(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const login = await request.post("/api/auth/login", { data: { email, password } });
  expect(login.ok()).toBe(true);
  const { stage } = (await login.json()) as { stage?: string };

  if (stage === "enrollment") {
    const enroll = await request.post("/api/auth/second-factor/enroll");
    expect(enroll.ok()).toBe(true);
    const { secret } = (await enroll.json()) as { secret: string };
    registerAccount(email, secret, []);
    const confirm = await request.post("/api/auth/second-factor/enroll/confirm", {
      data: { code: await nextTotpCode(email) },
    });
    expect(confirm.ok()).toBe(true);
    const { backupCodes } = (await confirm.json()) as { backupCodes: string[] };
    writeAccount(email, { ...storedAccount(email), backupCodes });
    return;
  }

  expect(stage).toBe("second_factor");
  const verify = await request.post("/api/auth/second-factor/verify", {
    data: { code: await nextTotpCode(email) },
  });
  expect(verify.ok()).toBe(true);
}
