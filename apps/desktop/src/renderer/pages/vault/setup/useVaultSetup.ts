import { useQuery } from "@tanstack/react-query";
import * as setup from "@backend/vault-setup";
import { useSessionPersonId } from "../../../data/queries";

// Lo stato della cassaforte per l'app (attiva, la propria chiave, quali
// passkey la aprono): lo legge «Use for the vault» in Preferenze → Security.
// Le scritture della fase 2 stanno nella pagina a sé (`vaultPage/`, I-2).

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
