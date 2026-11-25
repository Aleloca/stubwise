import { useQuery } from "@tanstack/react-query";
import * as api from "@backend/api";
import { queryKeys, useSessionPersonId, useWrite } from "../queries";

// Gli hook della Cassaforte (lotto 10, shape `vault.md`); `data/queries` li
// ri-esporta. Tutto sta nell'area «vault»: aprire, chiudere, condividere,
// confermare cambiano la barra e le righe insieme. «Show» non passa da una
// cache (`secret`): la password vive solo nello stato della riga che la
// mostra.

const VAULT_AREAS = ["vault"] as const;

/** La barra della cassaforte: lo stato del Mac e della propria chiave. */
export function useVaultStatus() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.vaultStatus(me),
    queryFn: () => api.vault.getVaultStatus(),
  });
}

/** Le credenziali di un progetto (sezione Credentials) o di tutti i progetti (pagina Vault). */
export function useCredentials(
  filter: { projectId?: string; projectIds?: string[] },
  enabled = true,
) {
  const me = useSessionPersonId();
  const scope = filter.projectId ?? `all:${(filter.projectIds ?? []).join(",")}`;
  return useQuery({
    queryKey: queryKeys.credentials(me, scope),
    queryFn: () => api.vault.listCredentials(filter),
    enabled,
  });
}

/** La voce «Credentials» della colonna del progetto. */
export function useCredentialsEntry(projectId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.credentialsEntry(me, projectId ?? ""),
    queryFn: () => api.vault.getCredentialsEntry(projectId!),
    enabled: !!projectId,
  });
}

export function useVaultUnlock() {
  return useWrite(() => api.vault.unlock(), VAULT_AREAS);
}

export function useVaultLock() {
  return useWrite(() => api.vault.lock(), VAULT_AREAS);
}

/** «Show»: la password solo nel risultato, mai in una cache. */
export function useShowPassword() {
  return useWrite((id: string) => api.vault.show(id), VAULT_AREAS, { secret: true });
}

/** «Copy»: gli appunti li scrive il livello dati (nell'app, il main). */
export function useCopyPassword() {
  return useWrite((id: string) => api.vault.copy(id), VAULT_AREAS);
}
