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

/** Una credenziale (il pannello di dettaglio); `null` se chi guarda non la vede. */
export function useCredential(id: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.credential(me, id ?? ""),
    queryFn: () => api.vault.getCredential(id!),
    enabled: !!id,
  });
}

/** Il registro degli accessi (di una credenziale, o del progetto con `credentialId` vuoto). */
export function useAccessLog(projectId: string | undefined, credentialId = "") {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.accessLog(me, projectId ?? "", credentialId),
    queryFn: () =>
      api.vault.listAccessLog({ projectId: projectId!, ...(credentialId ? { credentialId } : {}) }),
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

/** Una credenziale nuova (non chiede la cassaforte aperta: le copie le dà il livello dati). */
export function useCreateCredential() {
  return useWrite(
    ({ projectId, input }: { projectId: string; input: api.vault.CredentialInput }) =>
      api.vault.createCredential(projectId, input),
    VAULT_AREAS,
  );
}

/** La modifica: i campi in chiaro; una password nuova vuole la cassaforte aperta. */
export function useUpdateCredential() {
  return useWrite(
    ({ id, input }: { id: string; input: Partial<api.vault.CredentialInput> }) =>
      api.vault.updateCredential(id, input),
    VAULT_AREAS,
  );
}

/** «Copy»: gli appunti li scrive il livello dati (nell'app, il main). */
export function useCopyPassword() {
  return useWrite((id: string) => api.vault.copy(id), VAULT_AREAS);
}
