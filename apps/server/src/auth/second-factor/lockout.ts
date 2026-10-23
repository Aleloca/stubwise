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

/*
 * Il tetto con richieste IN PARALLELO. `recordFailure` conta un codice dopo
 * averlo verificato: N richieste concorrenti leggono tutte «non bloccato»
 * prima che il primo fallimento sia scritto, e vengono valutati N codici. Qui
 * il tentativo si PRENOTA prima di verificare: il contatore conta i codici
 * sbagliati più quelli in volo, e oltre il tetto non se ne valuta un altro.
 * Le tre funzioni si usano insieme, solo tramite `attemptSecondFactor`
 * (`index.ts`).
 */

const notLocked = sql`(${users.secondFactorLockedUntil} is null or ${users.secondFactorLockedUntil} <= now())`;

/**
 * Oltre questo tempo senza una prenotazione nuova, un contatore pieno ma
 * senza blocco è una prenotazione PERSA: nessuna verifica dura tanto.
 */
export const RESERVATION_STALE_MS = 60 * 1000;

/**
 * Prenota un tentativo: UN UPDATE che incrementa il contatore solo se il
 * passo non è bloccato e il tetto non è già pieno (di fallimenti o di
 * tentativi in volo). `false` = il codice non va nemmeno valutato.
 *
 * Un contatore pieno senza blocco si risolve sempre in pochi istanti: la
 * chiusura del quinto tentativo lo blocca (`settleFailure`) o lo azzera
 * (`settleSuccess`). Se invece l'ultima prenotazione ha più di
 * {@link RESERVATION_STALE_MS}, qualche chiusura non è mai arrivata (processo
 * morto a metà verifica, errore del DB) e il passo resterebbe «occupato» per
 * sempre: il contatore riparte da questa prenotazione. Le prenotazioni perse
 * sono guasti del server, non qualcosa che chi prova i codici può provocare.
 */
export async function reserveAttempt(db: Db, userId: string): Promise<boolean> {
  const stale = sql`(${users.secondFactorFailures} >= ${SECOND_FACTOR_MAX_FAILURES} and (${users.secondFactorReservedAt} is null or ${users.secondFactorReservedAt} < now() - make_interval(secs => ${RESERVATION_STALE_MS / 1000})))`;
  const rows = await db
    .update(users)
    .set({
      secondFactorFailures: sql`case when ${stale} then 1 else ${users.secondFactorFailures} + 1 end`,
      secondFactorReservedAt: sql`now()`,
    })
    .where(
      sql`${users.id} = ${userId} and ${notLocked} and (${users.secondFactorFailures} < ${SECOND_FACTOR_MAX_FAILURES} or ${stale})`,
    )
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Il tentativo prenotato era sbagliato: la prenotazione resta come
 * fallimento. Se il tetto è pieno scatta il blocco (contatore a 0); il
 * `where` sul «non bloccato» fa sì che lo faccia scattare UNA sola richiesta,
 * l'unica che riceve `locked: true` (e che deve quindi fare gli effetti del
 * blocco).
 */
export async function settleFailure(
  db: Db,
  userId: string,
): Promise<{ locked: boolean; lockedUntil: Date | null }> {
  const lockUntil = new Date(Date.now() + SECOND_FACTOR_LOCK_MS);
  const rows = await db
    .update(users)
    .set({ secondFactorFailures: 0, secondFactorLockedUntil: lockUntil })
    .where(
      sql`${users.id} = ${userId} and ${notLocked} and ${users.secondFactorFailures} >= ${SECOND_FACTOR_MAX_FAILURES}`,
    )
    .returning({ until: users.secondFactorLockedUntil });
  return rows.length > 0
    ? { locked: true, lockedUntil: rows[0]!.until }
    : { locked: false, lockedUntil: null };
}

/**
 * Il tentativo prenotato era giusto: azzera il contatore, ma SOLO se nel
 * frattempo un'altra richiesta non ha fatto scattare il blocco. `false` = il
 * blocco è arrivato mentre si verificava, e il codice giusto non apre niente.
 */
export async function settleSuccess(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ secondFactorFailures: 0 })
    .where(sql`${users.id} = ${userId} and ${notLocked}`)
    .returning({ id: users.id });
  return rows.length > 0;
}
