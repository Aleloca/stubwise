import type { PasskeyAuthenticationOptions } from "@stubwise/shared";
import { request } from "./client";
import type { FreshPresence } from "./core";
import { touchPasskey, type Who } from "./unlock";
import { plainCeremony } from "./webauthn";

// La fase 2 della cassaforte nel browser dalla parte della PAGINA (design
// §10, I7): attivare, creare la propria chiave, una passkey in più, il kit
// di recupero (rotazione e recupero) e l'associazione del Mac. La
// crittografia e la rete stanno nel worker (`core.ts`); qui solo l'ordine
// delle cerimonie e delle richieste. La PRF passa al worker per transfer
// dentro `touchPasskey`, come nello sblocco.
//
// Gli esiti sono quelli del worker. Una riconferma chiesta (`reauth_required`)
// porta anche `error`, la forma che legge `useReauth`, così il dialogo «Confirm
// it's you» si apre da sé e l'azione riparte.

export type SetupOutcome = { ok: true } | { ok: false; code: string; error?: "reauth_required" };

/** Una riconferma chiesta, nella forma di `useReauth`. */
function reauthAware<T extends { ok: boolean; code?: string }>(out: T): T {
  return !out.ok && out.code === "reauth_required" ? { ...out, error: "reauth_required" } : out;
}

/** Il kit di recupero, generato nel worker: il testo arriva qui UNA volta, per mostrarlo. */
export async function generateKit(
  purpose: "activate" | "rotate",
): Promise<
  | { ok: true; kitText: string }
  | { ok: false; code: string; missing?: { id: string; projectId: string; service: string; label: string | null }[] }
> {
  return request({ t: "kit", purpose });
}

export async function forgetKit(): Promise<void> {
  await request({ t: "forgetKit" });
}

/**
 * Attiva la cassaforte col kit generato nel worker e crea la chiave di chi
 * attiva: la cerimonia PRIMA (una passkey senza PRF ferma tutto prima di
 * attivare), poi `activate` (che può chiedere la riconferma: la PRF ricevuta
 * si azzera e l'azione riparte da capo), poi la chiave con la stessa PRF.
 */
export async function activateInBrowser(who: Who): Promise<SetupOutcome> {
  const touched = await touchPasskey(who, { t: "prepare", purpose: "activate" });
  if (!touched.ok) return touched;
  const activated = await request<SetupOutcome>({ t: "activate" });
  if (!activated.ok) {
    void request({ t: "discard" });
    return reauthAware(activated);
  }
  return request<SetupOutcome>({
    t: "createKey",
    ...touched.presence,
    personId: touched.personId,
    sessionTag: touched.sessionTag,
  });
}

/** La propria chiave: la prima volta, o una NUOVA (`recreate`) quando nessuna passkey apre più quella viva. */
export async function createKeyInBrowser(who: Who, opts: { recreate?: boolean } = {}): Promise<SetupOutcome> {
  const recreate = opts.recreate ? { recreate: true } : {};
  const touched = await touchPasskey(who, { t: "prepare", purpose: "create", ...recreate });
  if (!touched.ok) return touched;
  return request<SetupOutcome>({
    t: "createKey",
    ...touched.presence,
    personId: touched.personId,
    sessionTag: touched.sessionTag,
    ...recreate,
  });
}

/**
 * «Use for the vault»: una passkey già registrata apre anche la cassaforte.
 * Prima una passkey che apre già la chiave, poi la passkey scelta (l'unica
 * offerta). Se la seconda non arriva, la prima metà si butta nel worker.
 */
export async function addPasskeyInBrowser(who: Who, passkeyId: string): Promise<SetupOutcome> {
  const first = await touchPasskey(who);
  if (!first.ok) return first;
  const begun = await request<SetupOutcome>({
    t: "sealBegin",
    ...first.presence,
    personId: first.personId,
    passkeyId,
  });
  if (!begun.ok) return begun;
  const second = await touchPasskey(who, { t: "prepare", purpose: "seal", passkeyId });
  if (!second.ok) {
    void request({ t: "discard" });
    return second;
  }
  return request<SetupOutcome>({ t: "sealFinish", ...second.presence });
}

/** Il kit nuovo al posto del vecchio, a cassaforte aperta. */
export async function rotateKitInBrowser(
  who: Who,
): Promise<SetupOutcome | { ok: false; code: "missing"; missing: { id: string; projectId: string; service: string; label: string | null }[] }> {
  const w = who();
  if (!w.personId) return { ok: false, code: "unauthenticated" };
  return reauthAware(await request<SetupOutcome>({ t: "rotateKit", personId: w.personId, sessionTag: w.sessionTag }));
}

/** Una persona che aspetta, vista col kit (senza le copie). */
export interface RecoveryPerson {
  userId: string;
  email: string;
  personKeyId: string;
  status: "pending" | "confirmed";
  createdAt: string;
  device: string | null;
  fingerprint: string;
  credentials: { id: string; projectId: string; service: string; label: string | null }[];
}

/** Il testo del kit va al worker, che ne ricava la privata: qui non resta. Legato a persona e sessione (I-1). */
export async function loadRecoveryKit(
  who: Who,
  kitText: string,
): Promise<{ ok: true; items: RecoveryPerson[] } | { ok: false; code: string; error?: "reauth_required" }> {
  const w = who();
  if (!w.personId) return { ok: false, code: "unauthenticated" };
  return reauthAware(
    await request<{ ok: true; items: RecoveryPerson[] } | { ok: false; code: string }>({
      t: "recoveryLoad",
      kitText,
      personId: w.personId,
      sessionTag: w.sessionTag,
    }),
  );
}

export type RecoveryConfirmOutcome =
  | { ok: true; saved: number; keyChanged: number; notAllowed: number; unopenable: number; items: RecoveryPerson[] | null }
  | { ok: false; code: string; error?: "reauth_required" };

/**
 * Conferma col kit, con una presenza FRESCA (I-1): una passkey qualunque,
 * senza PRF; se la persona non ne ha (`code_required`), la pagina chiede il
 * codice dell'app e lo ripassa qui, che lo consegna al worker e basta.
 */
export async function confirmWithRecoveryKit(
  who: Who,
  personKeyId: string,
  code?: string,
): Promise<RecoveryConfirmOutcome> {
  const w = who();
  if (!w.personId) return { ok: false, code: "unauthenticated" };
  let presence: FreshPresence;
  if (code !== undefined) presence = { kind: "code", code };
  else {
    const prepared = await request<{ ok: true; options: PasskeyAuthenticationOptions } | { ok: false; code: string }>({
      t: "presenceOptions",
    });
    if (!prepared.ok) return prepared.code === "no_passkeys" ? { ok: false, code: "code_required" } : prepared;
    const touched = await plainCeremony(prepared.options);
    if (!touched.ok) return touched;
    presence = { kind: "passkey", assertion: touched.assertion };
  }
  return request<RecoveryConfirmOutcome>({
    t: "recoveryConfirm",
    personKeyId,
    personId: w.personId,
    sessionTag: w.sessionTag,
    presence,
  });
}

export async function forgetRecoveryKit(): Promise<void> {
  await request({ t: "recoveryForget" });
}

/** L'associazione del Mac per `state`: nome e login del Mac, mai l'impronta (M3). */
export async function lookupPairing(
  state: string,
): Promise<
  | { ok: true; deviceName: string; patCreatedAt: string | null; patLastUsedAt: string | null; expiresAt: string }
  | { ok: false; code: string }
> {
  return request({ t: "pairLookup", state });
}

/** Sigilla la propria chiave per il Mac: gli ultimi 4 scritti, e la passkey. */
export async function sealPairingInBrowser(who: Who, state: string, typed: string): Promise<SetupOutcome> {
  const touched = await touchPasskey(who);
  if (!touched.ok) return touched;
  return request<SetupOutcome>({ t: "pairSeal", state, typed, ...touched.presence, personId: touched.personId });
}
