import type { Db } from "@stubwise/db";
import { consumeBackupCode } from "./backup-codes.js";
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
