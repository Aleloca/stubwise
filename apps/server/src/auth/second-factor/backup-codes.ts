import { randomInt } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { userBackupCodes, type Db } from "@stubwise/db";
import { hashServerKey } from "../../routes/shared.js";

export const BACKUP_CODE_COUNT = 10;
// Senza caratteri ambigui (0/o, 1/l/i): il codice si legge e si ricopia a mano.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function generateCode(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Maiuscole e trattino non contano: `ABCDE-fghjk` e `abcdefghjk` sono lo stesso codice. */
function normalize(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hashCode(code: string): string {
  return hashServerKey(normalize(code));
}

/** Cancella i codici precedenti (usati o no) e ne scrive di nuovi; ritorna i chiari, una volta sola. */
export async function regenerateBackupCodes(db: Db, userId: string): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateCode);
  await db.transaction(async (tx) => {
    await tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, userId));
    await tx
      .insert(userBackupCodes)
      .values(codes.map((c) => ({ userId, codeHash: hashCode(c) })));
  });
  return codes;
}

/** Consuma un codice: l'UPDATE guardato `used_at is null` lo rende monouso anche in corsa. */
export async function consumeBackupCode(db: Db, userId: string, code: string): Promise<boolean> {
  const updated = await db
    .update(userBackupCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(userBackupCodes.userId, userId),
        eq(userBackupCodes.codeHash, hashCode(code)),
        isNull(userBackupCodes.usedAt),
      ),
    )
    .returning({ id: userBackupCodes.id });
  return updated.length > 0;
}

export async function remainingBackupCodes(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userBackupCodes)
    .where(and(eq(userBackupCodes.userId, userId), isNull(userBackupCodes.usedAt)));
  return row?.n ?? 0;
}
