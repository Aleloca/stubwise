import type { PasskeyAuthenticationOptions } from "@stubwise/shared";
import { request, stashPrf } from "./client";
import type { CoreRequest, Presence } from "./core";
import { ceremony } from "./webauthn";

// Lo sblocco della cassaforte nella build web (revisione di sicurezza I-1):
// 1. il worker legge lo stato e le opzioni della passkey (`prepare`), e
//    risponde con le sole passkey che hanno un sigillo;
// 2. la pagina fa la cerimonia (`webauthn.ts`): la PRF passa al worker per
//    TRANSFER appena c'è (`stash`, I-A), prima di ogni altra lettura;
// 3. persona e sessione si ricontrollano (M-3), poi lo sblocco con la
//    risposta senza PRF: il worker verifica, apre il sigillo con la PRF
//    ricevuta e tiene la chiave. Altrimenti il worker la azzera.
// La prima chiave, l'attivazione, il recupero e l'associazione (fase 2)
// stanno in `setup.ts`, con la stessa cerimonia.

export type UnlockOutcome = { ok: true } | { ok: false; code: string };

export type Who = () => { personId: string | null; sessionTag: string };

/**
 * La cerimonia, fino alla PRF nel worker: le opzioni dal worker
 * (`prepare`), la passkey (`webauthn.ts`, la PRF nello `stash` per
 * transfer), poi il ricontrollo di persona e sessione (M-3; se non regge, il
 * worker azzera la PRF).
 */
export async function touchPasskey(
  who: Who,
  prepare: Extract<CoreRequest, { t: "prepare" }> = { t: "prepare" },
): Promise<{ ok: true; personId: string; sessionTag: string; presence: Presence } | { ok: false; code: string }> {
  const before = who();
  if (!before.personId) return { ok: false, code: "unauthenticated" };
  const prepared = await request<
    { ok: true; options: PasskeyAuthenticationOptions; onlyCredentialIds: string[] } | { ok: false; code: string }
  >(prepare);
  if (!prepared.ok) return prepared;
  const outcome = await ceremony(prepared.options, stashPrf);
  if (!outcome.ok) return outcome;
  // M-3: chi apre è ancora chi ha cominciato, nella stessa sessione.
  const after = who();
  if (after.personId !== before.personId || after.sessionTag !== before.sessionTag) {
    // La PRF è già nel worker: la azzera lì.
    void request({ t: "discard" });
    return { ok: false, code: "session" };
  }
  return {
    ok: true,
    personId: before.personId,
    sessionTag: before.sessionTag,
    presence: { assertion: outcome.assertion, credentialId: outcome.credentialId },
  };
}

export async function unlockInBrowser(who: Who): Promise<UnlockOutcome> {
  const touched = await touchPasskey(who);
  if (!touched.ok) return touched;
  return request<UnlockOutcome>({
    t: "unlock",
    ...touched.presence,
    personId: touched.personId,
    sessionTag: touched.sessionTag,
  });
}

/**
 * Revisione finale, punto 3 (come M5 del desktop): una presenza FRESCA per
 * conferma, rifiuto e rimozione di un lettore. La stessa cerimonia, ma la PRF
 * nel worker vale per quell'operazione sola: non riapre la cassaforte.
 */
export async function freshPresence(who: Who): Promise<{ ok: true; presence: Presence } | { ok: false; code: string }> {
  const touched = await touchPasskey(who);
  return touched.ok ? { ok: true, presence: touched.presence } : touched;
}
