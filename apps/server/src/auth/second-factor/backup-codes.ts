import { createHmac, randomInt } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { userBackupCodes, type Db } from "@stubwise/db";

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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

/**
 * Hash di un codice: HMAC-SHA256 con una sottochiave della chiave di
 * cifratura dell'istanza. Un codice ha ~50 bit: uno SHA-256 nudo si
 * proverebbe offline da un dump del DB, l'HMAC no senza la chiave (che nel
 * DB non c'è). La sottochiave tiene separato questo uso da `encrypt`.
 */
function hashCode(key: Buffer, code: string): string {
  const subkey = createHmac("sha256", key).update("stubwise/backup-codes").digest();
  return createHmac("sha256", subkey).update(normalize(code)).digest("hex");
}

/** Cancella i codici precedenti (usati o no) e ne scrive di nuovi; ritorna i chiari, una volta sola. */
export async function regenerateBackupCodes(
  db: DbOrTx,
  key: Buffer,
  userId: string,
): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateCode);
  await db.transaction(async (tx) => {
    await tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, userId));
    await tx
      .insert(userBackupCodes)
      .values(codes.map((c) => ({ userId, codeHash: hashCode(key, c) })));
  });
  return codes;
}

/** Consuma un codice: l'UPDATE guardato `used_at is null` lo rende monouso anche in corsa. */
export async function consumeBackupCode(
  db: Db,
  key: Buffer,
  userId: string,
  code: string,
): Promise<boolean> {
  const updated = await db
    .update(userBackupCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(userBackupCodes.userId, userId),
        eq(userBackupCodes.codeHash, hashCode(key, code)),
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
