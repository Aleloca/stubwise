import type { PasskeyAuthenticationOptions } from "@stubwise/shared";
import { request, stashPrf } from "./client";
import { ceremony } from "./webauthn";

// Lo sblocco della cassaforte nella build web (revisione di sicurezza I-1):
// 1. il worker legge lo stato e le opzioni della passkey (`prepare`), e
//    risponde con le sole passkey che hanno un sigillo;
// 2. la pagina fa la cerimonia (`webauthn.ts`): la PRF passa al worker per
//    TRANSFER appena c'è (`stash`, I-A), prima di ogni altra lettura;
// 3. persona e sessione si ricontrollano (M-3), poi lo sblocco con la
//    risposta senza PRF: il worker verifica, apre il sigillo con la PRF
//    ricevuta e tiene la chiave. Altrimenti il worker la azzera.
// La prima chiave, l'attivazione e il recupero sono la fase 2: qui no.

export type UnlockOutcome = { ok: true } | { ok: false; code: string };

export async function unlockInBrowser(who: () => { personId: string | null; sessionTag: string }): Promise<UnlockOutcome> {
  const before = who();
  if (!before.personId) return { ok: false, code: "unauthenticated" };
  const prepared = await request<
    { ok: true; options: PasskeyAuthenticationOptions; onlyCredentialIds: string[] } | { ok: false; code: string }
  >({ t: "prepare" });
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
  return request<UnlockOutcome>(
    {
      t: "unlock",
      assertion: outcome.assertion,
      credentialId: outcome.credentialId,
      personId: before.personId,
      sessionTag: before.sessionTag,
    },
  );
}
