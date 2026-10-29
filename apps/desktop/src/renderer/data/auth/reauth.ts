import { accessState, writeAccess, type PersonAccess } from "../access/index";
import { consumeBackupCode, forgetSecret, secretIdsOf, storeSecret } from "../admin/secrets";
import { gate, now, state, type ApiFnName } from "../store";
import { forbidden, invalid } from "../writer";

// La riconferma col secondo fattore (area 9a, `second-factor.md`). Ogni
// funzione delicata dell'API si DICHIARA in `REAUTH_REQUIRED`, e la sua
// scrittura chiede `requireReauth(me, nome)` dopo il cancello e prima di
// toccare lo stato: senza una riconferma degli ultimi
// `REAUTH_GRACE_MINUTES` minuti risponde `reauth_required` e non cambia
// niente. La finestra vale PER PERSONA (`state.reauth`): cambiare persona
// col «vedi come» non la passa all'altra, e tornare alla prima la ritrova se
// non è scaduta.
//
// Un token personale (PAT) non la soddisfa mai: nel prototipo non esistono
// chiamate via PAT, quindi ogni chiamata è di una sessione.
//
// SOLO PROTOTIPO: il codice dell'app è fisso (`PROTOTYPE_TOTP_CODE`, mostrato
// nel riquadro «Prototype only»), la passkey riesce sempre se la persona ne
// ha una; niente anti-replay del passo TOTP.

export const REAUTH_GRACE_MINUTES = 10;
/** Codici sbagliati di fila prima del blocco, e quanto dura (`second-factor.md`). */
export const SECOND_FACTOR_MAX_FAILURES = 5;
export const SECOND_FACTOR_LOCK_MINUTES = 15;
/** Il codice dell'app di autenticazione per tutti, nel prototipo. */
export const PROTOTYPE_TOTP_CODE = "123456";

/**
 * Le funzioni delicate dell'API: quelle marcate «+R» nei Task 4 e 5 del
 * piano 9a. Si aggiungono INSIEME alla funzione (il nome entra in
 * `ApiFnName` con lei), e il test del registro
 * (`reauth.test.ts`, «registro») elenca le stesse: aggiungerne una è una
 * decisione visibile nel diff.
 */
export const REAUTH_REQUIRED: ReadonlySet<ApiFnName> = new Set<ApiFnName>([]);

const MINUTE = 60_000;

/** Vero se la persona ha una riconferma ancora nella finestra di grazia (estremo compreso). */
export function hasFreshReauth(personId: string): boolean {
  const at = state.reauth.get(personId);
  if (at === undefined) return false;
  return Date.parse(now()) - Date.parse(at) <= REAUTH_GRACE_MINUTES * MINUTE;
}

/**
 * Il controllo di una scrittura delicata: `null` se può procedere,
 * `"reauth_required"` se la funzione è dichiarata e la riconferma manca o è
 * scaduta. Va chiamata DOPO il cancello e PRIMA di ogni scrittura.
 */
export function requireReauth(me: string, fn: ApiFnName): null | "reauth_required" {
  if (!REAUTH_REQUIRED.has(fn)) return null;
  return hasFreshReauth(me) ? null : "reauth_required";
}

/**
 * Segna una riconferma riuscita adesso. La usa anche l'iscrizione al secondo
 * fattore (Task 5): a fine configurazione la sessione conta come
 * riconfermata (`second-factor.md`).
 */
export function markReauthenticated(personId: string): void {
  state.reauth.set(personId, now());
}

export type SecondFactorInput =
  | { method: "totp"; code: string }
  | { method: "passkey" }
  | { method: "backup_code"; code: string };

export type SecondFactorResult =
  | { ok: true }
  | { ok: false; error: "invalid_code"; triesLeft: number }
  | { ok: false; error: "locked"; lockedUntil: string }
  | { ok: false; error: "no_second_factor" };

const personOf = (personId: string): PersonAccess | undefined =>
  accessState().people.find((p) => p.personId === personId);

/** Il blocco in corso (ISO di fine), o `null`; un blocco scaduto si azzera. */
function lockedUntil(personId: string): string | null {
  const a = state.secondFactorAttempts.get(personId);
  if (!a?.lockedUntil) return null;
  if (Date.parse(now()) < Date.parse(a.lockedUntil)) return a.lockedUntil;
  state.secondFactorAttempts.delete(personId);
  return null;
}

function verify(person: PersonAccess, input: SecondFactorInput): boolean {
  const sf = person.secondFactor!;
  switch (input.method) {
    case "totp":
      return sf.totp && input.code.trim() === PROTOTYPE_TOTP_CODE;
    case "passkey":
      return sf.passkeys > 0;
    case "backup_code": {
      const left = consumeBackupCode(person.personId, input.code);
      if (left === null) return false;
      writeAccess((s) => {
        const p = s.people.find((x) => x.personId === person.personId);
        if (p?.secondFactor) p.secondFactor.backupCodesLeft = left;
      });
      return true;
    }
  }
}

/**
 * L'UNICO punto che verifica un codice o una passkey e tiene il conto dei
 * fallimenti (come `attemptSecondFactor` del server): lo usano la
 * riconferma e, dal Task 5, il secondo passo del login. 5 codici sbagliati
 * di fila bloccano il secondo fattore per 15 minuti; un codice giusto
 * azzera il conto. Non segna la riconferma: lo fa chi chiama.
 */
export function attemptSecondFactor(
  personId: string,
  input: SecondFactorInput,
): SecondFactorResult {
  const person = personOf(personId);
  if (!person?.secondFactor) return { ok: false, error: "no_second_factor" };
  const locked = lockedUntil(personId);
  if (locked) return { ok: false, error: "locked", lockedUntil: locked };
  if (verify(person, input)) {
    state.secondFactorAttempts.delete(personId);
    return { ok: true };
  }
  const failures = (state.secondFactorAttempts.get(personId)?.failures ?? 0) + 1;
  if (failures >= SECOND_FACTOR_MAX_FAILURES) {
    const until = new Date(Date.parse(now()) + SECOND_FACTOR_LOCK_MINUTES * MINUTE).toISOString();
    state.secondFactorAttempts.set(personId, { failures: 0, lockedUntil: until });
    return { ok: false, error: "locked", lockedUntil: until };
  }
  state.secondFactorAttempts.set(personId, { failures, lockedUntil: null });
  return { ok: false, error: "invalid_code", triesLeft: SECOND_FACTOR_MAX_FAILURES - failures };
}

/**
 * Il dialogo «Confirm it's you»: verifica il secondo fattore di chi guarda
 * e, se riesce, apre la sua finestra di grazia. Chi non ha un secondo
 * fattore riceve `no_second_factor` e passa da `enrollDuringReauth`.
 */
export async function reauthenticate(input: SecondFactorInput): Promise<SecondFactorResult> {
  const me = await gate("auth.reauthenticate");
  const result = attemptSecondFactor(me, input);
  if (result.ok) markReauthenticated(me);
  return result;
}

/** Il primo passo della configurazione dell'app di autenticazione: la chiave, mostrata una volta. */
export interface TotpSetup {
  /** La chiave in base32 («Can't scan? Enter this key»). */
  secret: string;
  /** L'URI `otpauth://` che il QR codifica. */
  uri: string;
}

/**
 * L'iscrizione al volo dentro la riconferma (Sara): per chi non ha un
 * secondo fattore, prepara il segreto TOTP e lo restituisce una volta. Un
 * segreto in attesa di prima si dimentica. La conferma col primo codice e i
 * codici di backup sono del Task 5 (`confirmTotp`), che a fine
 * configurazione chiama `markReauthenticated`.
 */
export async function enrollDuringReauth(): Promise<TotpSetup> {
  const me = await gate("auth.enrollDuringReauth");
  const person = personOf(me);
  if (!person || person.status !== "active") throw forbidden();
  if (person.secondFactor) throw invalid("already_enrolled");
  for (const id of secretIdsOf("totp_seed", me)) forgetSecret(id);
  const { value } = storeSecret("totp_seed", me);
  return {
    secret: value,
    uri: `otpauth://totp/Stubwise:${encodeURIComponent(me)}?secret=${value}&issuer=Stubwise`,
  };
}
