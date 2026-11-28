import { useQuery } from "@tanstack/react-query";
import * as setup from "@backend/vault-setup";
import { useInvalidate, useSessionPersonId } from "../../../data/queries";

// Gli hook della fase 2 della cassaforte (design §10): lo stato per la pagina
// di configurazione (attiva, la propria chiave, quali passkey la aprono), in
// cache come le altre letture della cassaforte. Il testo di un kit e chi
// aspetta col kit NON passano da qui: li tiene lo stato del componente.

export function useVaultSetupStatus(enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "vault", "setup"] as const,
    queryFn: async () => {
      const out = await setup.vaultSetupStatus();
      if (!out.ok) throw new Error(out.code);
      return out;
    },
    enabled: enabled && setup.vaultSetupAvailable,
    retry: false,
  });
}

/** Dopo una scrittura della fase 2: la barra, le righe e lo stato si rileggono. */
export function useVaultChanged() {
  return useInvalidate(["vault"]);
}

/** Il codice di un esito nella frase da mostrare; un codice ignoto è «qualcosa non è andato». */
export function setupErrorKey(code: string): string {
  const known = [
    "unauthenticated",
    "passkey_failed",
    "passkey_unsupported",
    "no_seal",
    "no_passkeys",
    "passkey_unknown",
    "open_failed",
    "stale_key",
    "no_prf",
    "session",
    "vault_already_active",
    "has_key",
    "already_sealed",
    "fingerprint_mismatch",
    "pairing_invalid",
    "no_pairing",
    "nothing_opened",
    "not_pending",
    "worker_unavailable",
    "network",
    "forbidden",
    "code_required",
    "presence_required",
    "invalid_second_factor",
    "locked",
  ];
  return `vault.setup.errors.${known.includes(code) ? code : "failed"}`;
}
