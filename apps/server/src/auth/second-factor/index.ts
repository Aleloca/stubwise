import type { Db } from "@stubwise/db";
import { publishSecurityAlert } from "./alerts.js";
import { consumeBackupCode } from "./backup-codes.js";
import { lockedUntil, recordFailure } from "./lockout.js";
import { recordSecurityEvent } from "./security-events.js";
import { verifyTotp } from "./totp.js";
import { users } from "@stubwise/db";
import { eq } from "drizzle-orm";

/**
 * Un codice del secondo fattore: 6 cifre = TOTP, altro = codice di riserva
 * (che lascia traccia nel registro). Non tocca il tetto: lo fa il chiamante.
 */
export async function verifySecondFactorCode(
  db: Db,
  key: Buffer,
  userId: string,
  code: string,
): Promise<"totp" | "backup" | null> {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    return (await verifyTotp(db, key, userId, trimmed)) ? "totp" : null;
  }
  if (!(await consumeBackupCode(db, userId, trimmed))) return null;
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (user) await recordSecurityEvent(db, { kind: "backup_code_used", user });
  return "backup";
}

/**
 * Un codice del secondo fattore sbagliato, in UN posto per tutte le porte
 * (login web, passkey, riconferma, login dell'app): conta per il tetto
 * dell'account e, se il blocco scatta proprio ora, lo scrive nel registro e
 * avvisa l'interessato. Nessuna porta ripete questi effetti per conto suo.
 */
export async function secondFactorFailed(
  db: Db,
  user: { id: string; email: string },
): Promise<{ locked: boolean; lockedUntil: Date | null }> {
  const { locked } = await recordFailure(db, user.id);
  if (!locked) return { locked: false, lockedUntil: null };
  await recordSecurityEvent(db, { kind: "locked", user });
  await publishSecurityAlert(db, user.id, "locked", null);
  return { locked: true, lockedUntil: await lockedUntil(db, user.id) };
}
