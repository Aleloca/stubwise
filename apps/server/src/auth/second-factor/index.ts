import type { Db } from "@stubwise/db";
import { publishSecurityAlert } from "./alerts.js";
import { consumeBackupCode } from "./backup-codes.js";
import { lockedUntil, reserveAttempt, settleFailure, settleSuccess } from "./lockout.js";
import { recordSecurityEvent } from "./security-events.js";
import { verifyTotp } from "./totp.js";
import { users } from "@stubwise/db";
import { eq } from "drizzle-orm";

/**
 * Un codice del secondo fattore: 6 cifre = TOTP, altro = codice di riserva
 * (che lascia traccia nel registro). Non tocca il tetto: lo fa il chiamante.
 * Spazi e trattini non contano per il TOTP: un «123 456» incollato da
 * un'app resta un TOTP, non un codice di riserva sbagliato.
 */
export async function verifySecondFactorCode(
  db: Db,
  key: Buffer,
  userId: string,
  code: string,
): Promise<"totp" | "backup" | null> {
  const trimmed = code.trim();
  const digits = trimmed.replace(/[\s-]/g, "");
  if (/^\d{6}$/.test(digits)) {
    return (await verifyTotp(db, key, userId, digits)) ? "totp" : null;
  }
  if (!(await consumeBackupCode(db, key, userId, trimmed))) return null;
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (user) await recordSecurityEvent(db, { kind: "backup_code_used", user });
  return "backup";
}

export type SecondFactorAttempt<T> =
  | { ok: true; result: T }
  | { ok: false; reason: "wrong" | "busy" }
  | { ok: false; reason: "locked"; lockedUntil: Date };

type Failure = Extract<SecondFactorAttempt<unknown>, { ok: false }>;

/**
 * UN tentativo di secondo fattore, con il tetto per account, per TUTTE le
 * porte (login web, passkey, riconferma, login dell'app): nessuna porta
 * legge il blocco, verifica e conta per conto suo.
 *
 * Sequenza: prenota il tentativo (`reserveAttempt`: rifiutato se bloccato o
 * se il tetto è pieno anche solo di tentativi in volo) → `verify` → chiude la
 * prenotazione. Così N richieste in parallelo da N IP non valutano più di
 * {@link SECOND_FACTOR_MAX_FAILURES} codici, e un codice giusto verificato
 * mentre un'altra richiesta faceva scattare il blocco non apre niente.
 *
 * `verify` ritorna il risultato (verità = riuscito) oppure `null`/`false`.
 * Gli effetti del blocco (evento `locked` e avviso) li fa solo la richiesta
 * che lo fa scattare: uno per blocco. Un'eccezione di `verify` conta come
 * codice sbagliato, poi risale.
 *
 * Esiti negativi: `wrong` (codice sbagliato), `locked` (passo bloccato,
 * anche dal tentativo che fa scattare il blocco) e `busy` (codice NON
 * valutato: il tetto è pieno di tentativi ancora in volo; si riprova).
 */
export async function attemptSecondFactor<T>(
  db: Db,
  user: { id: string; email: string },
  verify: () => Promise<T | null | false>,
): Promise<SecondFactorAttempt<NonNullable<Exclude<T, false>>>> {
  if (!(await reserveAttempt(db, user.id))) {
    return lockedOr(db, user.id, "busy");
  }
  let result: T | null | false;
  try {
    result = await verify();
  } catch (error) {
    // Conta come codice sbagliato, ma l'errore che risale è quello di
    // `verify`: un guasto della chiusura non lo deve coprire (e se la
    // chiusura non avviene, la prenotazione scade da sola in `reserveAttempt`).
    await failed(db, user).catch(() => undefined);
    throw error;
  }
  if (!result) return failed(db, user);
  if (!(await settleSuccess(db, user.id))) {
    // Il blocco è scattato mentre si verificava: il codice giusto non apre.
    return lockedOr(db, user.id, "busy");
  }
  return { ok: true, result: result as NonNullable<Exclude<T, false>> };
}

/** Chiude un tentativo sbagliato; se è quello che blocca, gli effetti (una volta). */
async function failed(db: Db, user: { id: string; email: string }): Promise<Failure> {
  const { locked, lockedUntil: until } = await settleFailure(db, user.id);
  if (!locked || !until) return { ok: false, reason: "wrong" };
  await recordSecurityEvent(db, { kind: "locked", user });
  await publishSecurityAlert(db, user.id, "locked", null);
  return { ok: false, reason: "locked", lockedUntil: until };
}

/** `locked` se il passo è bloccato adesso, altrimenti `fallback`. */
async function lockedOr(db: Db, userId: string, fallback: "busy"): Promise<Failure> {
  const until = await lockedUntil(db, userId);
  return until
    ? { ok: false, reason: "locked", lockedUntil: until }
    : { ok: false, reason: fallback };
}
