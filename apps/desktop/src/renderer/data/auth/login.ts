import { accessState } from "../access/index";
import { loginEmailOf, passwordOf, personByEmail } from "../me/account";
import { PEOPLE } from "../seed/people";
import { logSecurity } from "../me/securityLog";
import { advanceNow, gate, newId, now, state } from "../store";
import { instanceIsEmpty } from "./setup";
import {
  attemptSecondFactor,
  markReauthenticated,
  type SecondFactorInput,
  type SecondFactorResult,
} from "./reauth";

// Il login e l'uscita (area 9a, Ingresso). La password giusta di chi ha un
// secondo fattore NON fa entrare: apre un login a metà (10 minuti, come la
// sessione parziale del server) che solo il secondo passo completa, e quel
// passo passa da `attemptSecondFactor` (stesso conto, stesso blocco della
// riconferma). Chi non ha un secondo fattore (Sara) entra subito: la sua
// prima azione delicata le chiede di attivarlo (`second-factor.md`).
//
// L'errore è sempre `invalid_credentials`: email inesistente, password
// sbagliata e persona disattivata non si distinguono.
//
// Il login non cambia la persona di chi guarda: la restituisce, e la pagina
// la passa al «vedi come» (`setPersona`), che è l'unico a impostare la
// sessione del livello dati.

/** Quanto vale un login a metà prima di dover ridare la password. */
export const PARTIAL_LOGIN_MINUTES = 10;

export type LoginResult =
  | { ok: true; stage: "second_factor" }
  | { ok: true; stage: "in"; personId: string }
  | { ok: false; error: "invalid_credentials" };

export type LoginSecondFactorResult =
  | { ok: true; stage: "in"; personId: string }
  | Exclude<SecondFactorResult, { ok: true }>
  | { ok: false; error: "login_expired" };

const activePerson = (personId: string) =>
  accessState().people.find((p) => p.personId === personId && p.status === "active");

export type EntryStage = "out" | "second_factor" | "in";

function stageNow(): EntryStage {
  if (state.entry.signedIn) return "in";
  return partialOf() ? "second_factor" : "out";
}

/** Dove si è: fuori, a metà (manca il secondo fattore), dentro. */
export async function getEntry(): Promise<{ stage: EntryStage }> {
  await gate("auth.getEntry");
  return { stage: stageNow() };
}

/**
 * La stessa risposta di `getEntry`, più l'istanza vuota, SUBITO: la legge il
 * cancello delle rotte (`router.tsx`) a ogni navigazione, e una latenza lì
 * ritarderebbe ogni avvio dell'app (e ogni test che la monta). Nessun dato di
 * una persona: dice solo da quale porta si passa.
 */
export function readEntry(): { stage: EntryStage; empty: boolean } {
  return { stage: stageNow(), empty: instanceIsEmpty() };
}

/** Il login a metà ancora valido, o `null`. */
function partialOf(): { personId: string } | null {
  const partial = state.entry.partial;
  if (!partial) return null;
  if (Date.parse(now()) - Date.parse(partial.at) > PARTIAL_LOGIN_MINUTES * 60_000) return null;
  return partial;
}

/** Si entra: la sessione di questa app (una, la corrente) e una riga nel registro. */
function signIn(personId: string): { ok: true; stage: "in"; personId: string } {
  state.entry = { signedIn: true, partial: null };
  state.sessions = state.sessions.filter((s) => !(s.personId === personId && s.current));
  state.sessions.push({
    id: newId("ses"),
    personId,
    device: { kind: "desktop", detail: "macOS" },
    createdAt: now(),
    lastUsedAt: now(),
    current: true,
  });
  logSecurity(personId, "signed_in", null);
  return { ok: true, stage: "in", personId };
}

/** Email e password. Con un secondo fattore: `second_factor`; senza: dentro. */
export async function login(input: { email: string; password: string }): Promise<LoginResult> {
  await gate("auth.login");
  const personId = personByEmail(input.email);
  const person = personId ? activePerson(personId) : undefined;
  if (!personId || !person || input.password !== passwordOf(personId))
    return { ok: false, error: "invalid_credentials" };
  if (person.secondFactor) {
    state.entry = { signedIn: false, partial: { personId, at: now() } };
    return { ok: true, stage: "second_factor" };
  }
  return signIn(personId);
}

/**
 * Il secondo passo: codice dell'app, passkey o codice di backup. Il fattore
 * appena dato vale anche come riconferma (come `second_factor_at` del
 * server).
 */
export async function loginSecondFactor(
  input: SecondFactorInput,
): Promise<LoginSecondFactorResult> {
  await gate("auth.loginSecondFactor");
  const partial = partialOf();
  if (!partial || !activePerson(partial.personId)) {
    state.entry.partial = null;
    return { ok: false, error: "login_expired" };
  }
  const result = attemptSecondFactor(partial.personId, input);
  if (!result.ok) return result;
  markReauthenticated(partial.personId);
  return signIn(partial.personId);
}

/** «Sign out»: si chiude la sessione di questa app e si torna al login. */
export async function logout(): Promise<{ ok: true }> {
  const me = await gate("auth.logout");
  state.sessions = state.sessions.filter((s) => !(s.personId === me && s.current));
  state.entry = { signedIn: false, partial: null };
  if (activePerson(me)) logSecurity(me, "signed_out", null);
  return { ok: true };
}

/**
 * SOLO PROTOTIPO, il riquadro «Prototype only» del login («Sign in as:»):
 * nome ed email d'accesso delle persone chieste che sono attive, nell'ordine
 * chiesto. Una disattivata o sconosciuta non c'è (non entrerebbe comunque).
 */
export async function prototypeAccounts(
  personIds: string[],
): Promise<{ personId: string; name: string; email: string }[]> {
  await gate("auth.prototypeAccounts");
  return personIds.flatMap((personId) => {
    const person = PEOPLE.find((p) => p.id === personId);
    if (!person || !activePerson(personId)) return [];
    return [{ personId, name: person.name, email: loginEmailOf(personId) }];
  });
}

/** SOLO PROTOTIPO, «Pass 15 minutes» del blocco: l'orologio `now()` va avanti. */
export async function passMinutes(minutes: number): Promise<{ ok: true }> {
  await gate("auth.passMinutes");
  advanceNow(minutes * 60_000);
  return { ok: true };
}
