import type { VaultStatusResponse } from "@stubwise/shared";
import { request } from "../vaultBrowser/client";

// `@backend/vault-setup` nella build web (`/app`): dalla revisione della fase
// 2 (I-2) attivare, la propria chiave, il kit, il recupero, l'associazione e
// «Use for the vault» stanno nella pagina A SÉ della cassaforte
// (`vault.html`, `/vault/`, `vaultPage/`), con la sua CSP. Qui resta solo
// lo stato, per dire nell'app quali passkey aprono la cassaforte.

export const vaultSetupAvailable: boolean = true;

/** Lo stato per l'app: attiva, la propria chiave, quali passkey la aprono. */
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
