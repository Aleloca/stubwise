import { randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";
import { generateSync } from "otplib";

/*
 * Il secondo fattore negli E2E della nuova app: il primo login di un account
 * lo configura via API (`enroll`), e da lì ogni login, anche dalla UI, passa
 * dal codice dell'app, che `otplib` calcola come farebbe l'app di
 * autenticazione. I segreti stanno in un file della run (`start-stack.mjs`
 * lo ripulisce a ogni avvio), perché il worker di Playwright può ripartire.
 * È una copia ridotta di `apps/web/e2e/second-factor.ts`: quella sparirà col
 * web vecchio.
 */

/** Stessa cartella di `start-stack.mjs`. */
const STACK_DIR = path.join(os.tmpdir(), "stubwise-e2e-app");
const SECRETS_FILE = path.join(STACK_DIR, "totp.json");
const TOTP_PERIOD = 30;

interface StoredAccount {
  secret: string;
  /** L'ultimo passo usato: il server rifiuta un passo già usato (anti-replay). */
  lastStep: number;
}

function readAccounts(): Record<string, StoredAccount> {
  if (!existsSync(SECRETS_FILE)) return {};
  return JSON.parse(readFileSync(SECRETS_FILE, "utf8")) as Record<string, StoredAccount>;
}

function writeAccount(email: string, account: StoredAccount): void {
  writeFileSync(SECRETS_FILE, JSON.stringify({ ...readAccounts(), [email]: account }));
}

/** L'URL del Postgres dello stack, scritto da `start-stack.mjs`. */
export function stackDatabaseUrl(): string {
  return (JSON.parse(readFileSync(path.join(STACK_DIR, "stack.json"), "utf8")) as { databaseUrl: string }).databaseUrl;
}

/**
 * Un IP di client nuovo per contesto (lo stack ha `TRUST_PROXY`): il tetto di
 * tentativi per IP su login e secondo fattore resta per contesto.
 */
export function clientIpHeaders(): { extraHTTPHeaders: Record<string, string> } {
  return { extraHTTPHeaders: { "x-forwarded-for": `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}` } };
}

/**
 * Un codice dell'app non ancora usato per `email`: il passo corrente, o il
 * successivo se il corrente è già stato usato (il server tollera ±1 passo).
 * Se è usato anche quello, aspetta che arrivi il passo dopo: è uno stato vero
 * (l'orologio del TOTP), non un'attesa a caso.
 */
export async function nextTotpCode(email: string): Promise<string> {
  const account = readAccounts()[email];
  if (!account) throw new Error(`Nessun secondo fattore registrato per ${email}`);
  for (;;) {
    const current = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
    const step = Math.max(current, account.lastStep + 1);
    if (step <= current + 1) {
      writeAccount(email, { ...account, lastStep: step });
      return generateSync({ secret: account.secret, algorithm: "sha1", digits: 6, period: TOTP_PERIOD, epoch: step * TOTP_PERIOD });
    }
    await new Promise((r) => setTimeout(r, (step * TOTP_PERIOD - Date.now() / 1000) * 1000 + 50));
  }
}

/** Login via API (i cookie restano nel contesto): password, poi il codice o, al primo login, la configurazione. */
export async function signInWithRequest(request: APIRequestContext, email: string, password: string): Promise<void> {
  const login = await request.post("/api/auth/login", { data: { email, password } });
  expect(login.ok()).toBe(true);
  const { stage } = (await login.json()) as { stage?: string };
  if (stage === "enrollment") {
    const enroll = await request.post("/api/auth/second-factor/enroll");
    expect(enroll.ok()).toBe(true);
    const { secret } = (await enroll.json()) as { secret: string };
    writeAccount(email, { secret, lastStep: 0 });
    const confirm = await request.post("/api/auth/second-factor/enroll/confirm", { data: { code: await nextTotpCode(email) } });
    expect(confirm.ok()).toBe(true);
    return;
  }
  expect(stage).toBe("second_factor");
  const verify = await request.post("/api/auth/second-factor/verify", { data: { code: await nextTotpCode(email) } });
  expect(verify.ok()).toBe(true);
}
