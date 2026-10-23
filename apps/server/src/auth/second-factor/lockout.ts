import { eq, sql } from "drizzle-orm";
import { users, type Db } from "@stubwise/db";

export const SECOND_FACTOR_MAX_FAILURES = 5;
export const SECOND_FACTOR_LOCK_MS = 15 * 60 * 1000;

/** Fino a quando il passo del secondo fattore è bloccato, se lo è ancora. */
export async function lockedUntil(db: Db, userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ until: users.secondFactorLockedUntil })
    .from(users)
    .where(eq(users.id, userId));
  return row?.until && row.until.getTime() > Date.now() ? row.until : null;
}

/**
 * Registra un codice sbagliato. UN solo UPDATE incrementa il contatore e, al
 * quinto, imposta il blocco e azzera il contatore: due richieste in corsa non
 * possono sorpassare il tetto.
 */
export async function recordFailure(db: Db, userId: string): Promise<{ locked: boolean }> {
  const lockUntil = new Date(Date.now() + SECOND_FACTOR_LOCK_MS);
  const [row] = await db
    .update(users)
    .set({
      secondFactorFailures: sql`case when ${users.secondFactorFailures} + 1 >= ${SECOND_FACTOR_MAX_FAILURES} then 0 else ${users.secondFactorFailures} + 1 end`,
      secondFactorLockedUntil: sql`case when ${users.secondFactorFailures} + 1 >= ${SECOND_FACTOR_MAX_FAILURES} then ${lockUntil.toISOString()}::timestamptz else ${users.secondFactorLockedUntil} end`,
    })
    .where(eq(users.id, userId))
    .returning({ failures: users.secondFactorFailures });
  // Contatore tornato a 0 con un fallimento appena registrato = blocco scattato.
  return { locked: row?.failures === 0 };
}

/** Un secondo fattore riuscito azzera il contatore. */
export async function recordSuccess(db: Db, userId: string): Promise<void> {
  await db.update(users).set({ secondFactorFailures: 0 }).where(eq(users.id, userId));
}
