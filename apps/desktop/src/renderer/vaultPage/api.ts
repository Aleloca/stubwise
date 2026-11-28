import type { PasskeyAuthenticationOptions, VaultStatusResponse } from "@stubwise/shared";
import { request } from "../data/backend/real/vaultBrowser/client";
import * as setup from "../data/backend/real/vaultBrowser/setup";
import { unlockInBrowser } from "../data/backend/real/vaultBrowser/unlock";
import { plainCeremony } from "../data/backend/real/vaultBrowser/webauthn";

// Il livello dati della pagina A SÉ della cassaforte (revisione della fase 2,
// I-2): nessun modulo dell'app (niente api-client, React Query, router o
// «vedi come»). Chi guarda si legge da `/api/auth/me`; la crittografia, la
// rete della cassaforte e la riconferma passano dal worker (`core.ts`), come
// nella nuova app.

export interface Me {
  id: string;
  email: string;
  fullAdmin: boolean;
}

let me: Me | null = null;
/** L'etichetta di sessione della pagina: cambia (e chiude) quando cambia chi guarda. */
let epoch = 0;

export const who = () => ({ personId: me?.id ?? null, sessionTag: `v${epoch}` });

/** Chi guarda; `null` senza una sessione completa (anche a secondo fattore da dare). */
export async function loadMe(fetcher: typeof fetch = fetch): Promise<Me | null> {
  let res: Response;
  try {
    res = await fetcher("/api/auth/me", { credentials: "same-origin" });
  } catch {
    throw new Error("network");
  }
  if (res.status === 401 || res.status === 403) {
    me = null;
    return null;
  }
  if (!res.ok) throw new Error(`http_${res.status}`);
  const body = (await res.json()) as { user: { id: string; email: string }; instancePermissions?: string[] };
  if (me && me.id !== body.user.id) epoch += 1;
  me = {
    id: body.user.id,
    email: body.user.email,
    fullAdmin: (body.instancePermissions ?? []).includes("instance.full_admin"),
  };
  return me;
}

export type SetupStatus = {
  activated: boolean;
  key: "none" | "pending" | "confirmed";
  sealedPasskeyIds: string[];
};

export async function vaultStatus(): Promise<SetupStatus> {
  const out = await request<{ ok: true; status: VaultStatusResponse } | { ok: false; code: string }>({ t: "serverStatus" });
  if (!out.ok) throw new Error(out.code);
  const s = out.status;
  const live = s.myKey !== null && (s.myKey.status === "pending" || s.myKey.status === "confirmed");
  return {
    activated: s.activated,
    key: live ? (s.myKey!.status as "pending" | "confirmed") : "none",
    sealedPasskeyIds: live ? s.seals.map((x) => x.passkeyId) : [],
  };
}

/** Le proprie passkey (nome e id della riga), per «Use for the vault». */
export async function myPasskeys(fetcher: typeof fetch = fetch): Promise<{ id: string; name: string }[]> {
  const res = await fetcher("/api/me/security", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const body = (await res.json()) as { passkeys?: { id: string; name: string }[] };
  return (body.passkeys ?? []).map((p) => ({ id: p.id, name: p.name }));
}

/**
 * La riconferma della pagina a sé (I-2), senza il dialogo dell'app: una
 * passkey qualunque senza PRF, verificata dal worker; `code_required` se la
 * persona non ha passkey, e allora il codice, che il worker inoltra e basta.
 */
export async function confirmItsYou(code?: string): Promise<{ ok: true } | { ok: false; code: string }> {
  if (code !== undefined) return request({ t: "reauth", presence: { kind: "code", code } });
  const prepared = await request<{ ok: true; options: PasskeyAuthenticationOptions } | { ok: false; code: string }>({
    t: "presenceOptions",
  });
  if (!prepared.ok) return prepared.code === "no_passkeys" ? { ok: false, code: "code_required" } : prepared;
  const touched = await plainCeremony(prepared.options);
  if (!touched.ok) return touched;
  return request({ t: "reauth", presence: { kind: "passkey", assertion: touched.assertion } });
}

export const generateKit = setup.generateKit;
export const forgetKit = setup.forgetKit;
export const activateVault = () => setup.activateInBrowser(who);
export const createVaultKey = (opts: { recreate?: boolean } = {}) => setup.createKeyInBrowser(who, opts);
export const addPasskeyToVault = (passkeyId: string) => setup.addPasskeyInBrowser(who, passkeyId);
export const rotateRecoveryKit = () => setup.rotateKitInBrowser(who);
export const openVault = () => unlockInBrowser(who);
export const loadRecoveryKit = (kitText: string) => setup.loadRecoveryKit(who, kitText);
export const confirmWithRecoveryKit = (personKeyId: string, code?: string) => setup.confirmWithRecoveryKit(who, personKeyId, code);
export const forgetRecoveryKit = setup.forgetRecoveryKit;
export const lookupPairing = setup.lookupPairing;
export const sealPairing = (state: string, typed: string) => setup.sealPairingInBrowser(who, state, typed);
export type { RecoveryPerson } from "../data/backend/real/vaultBrowser/setup";
