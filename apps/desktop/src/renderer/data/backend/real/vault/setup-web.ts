import type { VaultStatusResponse } from "@stubwise/shared";
import { request } from "../vaultBrowser/client";
import * as setup from "../vaultBrowser/setup";
import { vaultWho } from "./web";

// `@backend/vault-setup` nella build web (`/app`, design della cassaforte
// nel browser §10, fase 2): attivare, creare la propria chiave, una passkey
// in più, ruotare il kit, il recupero e l'associazione del Mac. Tutto passa
// dal worker (`vaultBrowser/setup.ts` → `core.ts`); qui la persona e la
// sessione dello sblocco. Il testo di un kit non entra in una cache: lo
// tiene il componente che lo mostra, e lo butta.

export const vaultSetupAvailable: boolean = true;

/** Lo stato per la pagina: attiva, la propria chiave, quali passkey la aprono. */
export type VaultSetupStatus =
  | {
      ok: true;
      activated: boolean;
      key: "none" | "pending" | "confirmed";
      /** Le passkey (id della riga) che aprono la propria chiave viva. */
      sealedPasskeyIds: string[];
    }
  | { ok: false; code: string };

export async function vaultSetupStatus(): Promise<VaultSetupStatus> {
  const out = await request<{ ok: true; status: VaultStatusResponse } | { ok: false; code: string }>({ t: "serverStatus" });
  if (!out.ok) return out;
  const s = out.status;
  const live = s.myKey !== null && (s.myKey.status === "pending" || s.myKey.status === "confirmed");
  return {
    ok: true,
    activated: s.activated,
    key: live ? (s.myKey!.status as "pending" | "confirmed") : "none",
    sealedPasskeyIds: live ? s.seals.map((x) => x.passkeyId) : [],
  };
}

export const generateKit = setup.generateKit;
export const forgetKit = setup.forgetKit;
export const activateVault = () => setup.activateInBrowser(vaultWho);
export const createVaultKey = (opts: { recreate?: boolean } = {}) => setup.createKeyInBrowser(vaultWho, opts);
export const addPasskeyToVault = (passkeyId: string) => setup.addPasskeyInBrowser(vaultWho, passkeyId);
export const rotateRecoveryKit = () => setup.rotateKitInBrowser(vaultWho);
export const loadRecoveryKit = (kitText: string) => setup.loadRecoveryKit(vaultWho, kitText);
/** Senza `code`: una passkey; `code_required` se la persona non ne ha, e la pagina richiama col codice. */
export const confirmWithRecoveryKit = (personKeyId: string, code?: string) =>
  setup.confirmWithRecoveryKit(vaultWho, personKeyId, code);
export const forgetRecoveryKit = setup.forgetRecoveryKit;
export const lookupPairing = setup.lookupPairing;
export const sealPairing = (state: string, typed: string) => setup.sealPairingInBrowser(vaultWho, state, typed);
export type { RecoveryPerson } from "../vaultBrowser/setup";
