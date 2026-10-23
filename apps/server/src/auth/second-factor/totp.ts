import { timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { generateSecret, generateSync, generateURI } from "otplib";
import { decrypt, encrypt, userTotp, type Db } from "@stubwise/db";

/** TOTP delle app di autenticazione: 6 cifre, 30 s, SHA-1. */
export const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;
const TOTP_ISSUER = "Stubwise";

function stepOf(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD);
}

function codeAt(secret: string, step: number): string {
  return generateSync({
    secret,
    algorithm: "sha1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    epoch: step * TOTP_PERIOD,
  });
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Il passo (±1 rispetto a `nowMs`) a cui il codice corrisponde, o null.
 * Li prova tutti e tre senza uscire al primo: il tempo non dice quale.
 */
function matchingStep(secret: string, code: string, nowMs: number): number | null {
  const current = stepOf(nowMs);
  let found: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    if (sameCode(codeAt(secret, step), code)) found = step;
  }
  return found;
}

/**
 * Inizia (o rifà) la configurazione dell'app. Scrive SEMPRE il segreto
 * PENDENTE e lascia intatto quello confermato: la vecchia app continua a
 * valere finché la nuova non è confermata (`confirmTotp`).
 */
export async function startTotpEnrollment(
  db: Db,
  key: Buffer,
  user: { id: string; email: string },
): Promise<{ secret: string; otpauthUrl: string }> {
  const secret = generateSecret();
  const pendingSecretEncrypted = encrypt(secret, key);
  await db
    .insert(userTotp)
    .values({ userId: user.id, pendingSecretEncrypted })
    .onConflictDoUpdate({ target: userTotp.userId, set: { pendingSecretEncrypted } });
  const otpauthUrl = generateURI({
    issuer: TOTP_ISSUER,
    label: user.email,
    secret,
    algorithm: "sha1",
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
  });
  return { secret, otpauthUrl };
}

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Un codice giusto per il segreto PENDENTE: cosa confermare, non ancora confermato. */
export interface PendingTotpMatch {
  pendingSecretEncrypted: string;
  step: number;
}

/**
 * Verifica un codice contro il segreto pendente SENZA scrivere niente: la
 * conferma vera è {@link commitPendingTotp}, che chi chiama fa solo quando
 * il tentativo è andato a buon fine (tetto per account compreso), insieme a
 * quello che deve accadere con lei (codici di riserva, sessione promossa).
 */
export async function matchPendingTotp(
  db: Db,
  key: Buffer,
  userId: string,
  code: string,
  nowMs: number = Date.now(),
): Promise<PendingTotpMatch | null> {
  const [row] = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
  if (!row?.pendingSecretEncrypted) return null;
  const step = matchingStep(decrypt(row.pendingSecretEncrypted, key), code, nowMs);
  if (step === null) return null;
  return { pendingSecretEncrypted: row.pendingSecretEncrypted, step };
}

/**
 * Il segreto pendente verificato diventa quello confermato. Il passo del
 * codice è già "usato" (`lastUsedStep`), così lo stesso codice non vale
 * subito dopo. Guardato: se nel frattempo il pendente è cambiato, questa
 * conferma non vale; con `firstOnly` non vale nemmeno se un'app è stata
 * confermata nel frattempo (la configurazione del login non sostituisce mai
 * un'app esistente).
 */
export async function commitPendingTotp(
  db: DbOrTx,
  userId: string,
  match: PendingTotpMatch,
  opts: { nowMs?: number; firstOnly?: boolean } = {},
): Promise<boolean> {
  const firstOnly = opts.firstOnly ? sql` and ${userTotp.confirmedAt} is null` : sql``;
  const updated = await db
    .update(userTotp)
    .set({
      secretEncrypted: match.pendingSecretEncrypted,
      pendingSecretEncrypted: null,
      confirmedAt: new Date(opts.nowMs ?? Date.now()),
      lastUsedStep: match.step,
    })
    .where(
      sql`${userTotp.userId} = ${userId} and ${userTotp.pendingSecretEncrypted} = ${match.pendingSecretEncrypted}${firstOnly}`,
    )
    .returning({ userId: userTotp.userId });
  return updated.length > 0;
}

/**
 * Conferma l'app in configurazione in un passo solo
 * ({@link matchPendingTotp} + {@link commitPendingTotp}).
 */
export async function confirmTotp(
  db: Db,
  key: Buffer,
  userId: string,
  code: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const match = await matchPendingTotp(db, key, userId, code, nowMs);
  return match ? commitPendingTotp(db, userId, match, { nowMs }) : false;
}

/**
 * Verifica un codice al login. Vale solo il segreto confermato, con ±1 passo,
 * e un passo già usato (`step <= lastUsedStep`) è rifiutato: l'UPDATE
 * guardato rende l'anti-replay atomico anche con due richieste in corsa.
 */
export async function verifyTotp(
  db: Db,
  key: Buffer,
  userId: string,
  code: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const [row] = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
  if (!row?.secretEncrypted || !row.confirmedAt) return false;
  const step = matchingStep(decrypt(row.secretEncrypted, key), code, nowMs);
  if (step === null) return false;
  if (row.lastUsedStep !== null && step <= row.lastUsedStep) return false;
  const updated = await db
    .update(userTotp)
    .set({ lastUsedStep: step })
    .where(
      sql`${userTotp.userId} = ${userId} and (${userTotp.lastUsedStep} is null or ${userTotp.lastUsedStep} < ${step})`,
    )
    .returning({ userId: userTotp.userId });
  return updated.length > 0;
}

export async function hasConfirmedTotp(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ confirmedAt: userTotp.confirmedAt, secret: userTotp.secretEncrypted })
    .from(userTotp)
    .where(eq(userTotp.userId, userId));
  return Boolean(row?.confirmedAt && row.secret);
}
