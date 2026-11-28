import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import * as api from "@backend/api";
import { queryKeys, useSessionPersonId, useWrite } from "../queries";
import type { ReaderTarget, VaultSimulation } from "../vault/types";

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

/** Il riquadro «Prototype only»: cosa succede al prossimo Touch ID e alla prossima apertura. */
export function useVaultSimulation() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.vaultSimulation(me),
    queryFn: () => api.vault.getVaultSimulation(),
  });
}

export function useSetVaultSimulation() {
  return useWrite(
    (next: Partial<VaultSimulation>) => api.vault.setVaultSimulation(next),
    VAULT_AREAS,
  );
}

/** Il ritorno dal browser, simulato (il riquadro nel dialogo dell'associazione). */
export function useFinishPairing() {
  return useWrite(
    (outcome: "ok" | "expired" | "mismatch") => api.vault.finishPairing(outcome),
    VAULT_AREAS,
  );
}

/** I propri Mac che aprono la cassaforte (Preferenze → Security). */
export function useMyMacs() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.myMacs(me), queryFn: () => api.vault.listMyMacs() });
}

/** I Mac di un'altra persona (D-6): solo per un full admin (altrimenti `forbidden`). */
export function useMacsOf(personId: string, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.macsOf(me, personId),
    queryFn: () => api.vault.listMacsOf(personId),
    enabled,
  });
}

/** «Remove…» del Mac di un'altra persona (D-6), con la riconferma. */
export function useRemoveMacOf() {
  return useWrite(
    ({ personId, macId }: { personId: string; macId: string }) =>
      api.vault.removeMacOf(personId, macId),
    VAULT_AREAS,
  );
}

/** «Forget this Mac»: il proprio sigillo e il locale; il login resta. */
export function useForgetThisMac() {
  return useWrite(() => api.vault.forgetThisMac(), VAULT_AREAS);
}

/** «Remove» di un altro proprio Mac: riconferma e cassaforte aperta (VA-Q4). */
export function useRemoveMac() {
  return useWrite((macId: string) => api.vault.removeMac(macId), VAULT_AREAS);
}

/** «Pair this Mac»: il main chiede l'accoppiamento e apre il browser; risponde l'impronta. */
export function useStartPairing() {
  return useWrite(() => api.vault.startPairing(), VAULT_AREAS);
}

/**
 * Annulla l'associazione senza un componente montato (review M6: il dialogo
 * chiuso mentre la richiesta era in volo; quando torna, si annulla da qui).
 */
export function cancelPairingNow(): Promise<void> {
  return api.vault.cancelPairing();
}

/** Chiudere il dialogo durante l'attesa: la richiesta si dimentica. */
export function useCancelPairing() {
  return useWrite(() => api.vault.cancelPairing(), VAULT_AREAS);
}

/**
 * Lo stato della cassaforte cambiato da fuori (nell'app: il main, per
 * chiusura a tempo, sospensione, revoca): l'area «vault» si rilegge.
 * Montato una volta, dall'host dei comandi della cassaforte.
 */
export function useVaultChanges() {
  const client = useQueryClient();
  const me = useSessionPersonId();
  useEffect(
    () =>
      api.vault.subscribeVaultChanges(() => {
        void client.invalidateQueries({ queryKey: ["as", me, "vault"] });
      }),
    [client, me],
  );
}

/**
 * Chi tiene una password in chiaro nel suo stato ascolta i cambi della
 * cassaforte DIRETTAMENTE (design della cassaforte nel browser §6, I3): una
 * chiusura arriva subito, senza aspettare la rilettura della query.
 */
export function useOnVaultChange(fn: () => void) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => api.vault.subscribeVaultChanges(() => latest.current()), []);
}

/** L'esito del ritorno dal browser, a chi ha il dialogo aperto. */
export function usePairingResult(listener: (result: api.vault.PairingResult) => void) {
  const latest = useRef(listener);
  latest.current = listener;
  const client = useQueryClient();
  const me = useSessionPersonId();
  useEffect(
    () =>
      api.vault.subscribePairing((r) => {
        // Il ritorno arriva fuori da `useWrite` (dal browser, dal main): la
        // barra e le righe si rileggono, la cassaforte ora è aperta.
        void client.invalidateQueries({ queryKey: ["as", me, "vault"] });
        latest.current(r);
      }),
    [client, me],
  );
}

/** La voce «Vault» della barra laterale (e dove «New credential» può creare). */
export function useVaultEntry() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.vaultEntry(me),
    queryFn: () => api.vault.getVaultEntry(),
  });
}

/** Chi aspetta che io confermi la sua chiave (con le credenziali che posso passargli). */
export function useVaultPending() {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.vaultPending(me),
    queryFn: () => api.vault.listPending(),
  });
}

/** «Yes, I checked: confirm»: con la cassaforte aperta. */
export function useConfirmKey() {
  return useWrite((keyId: string) => api.vault.confirm(keyId), VAULT_AREAS);
}

/** «Yes, reject the key»: con la cassaforte aperta. */
export function useRejectKey() {
  return useWrite((keyId: string) => api.vault.reject(keyId), VAULT_AREAS);
}

/** I lettori di una credenziale (effettivi e diretti) nel dettaglio. */
export function useReaders(id: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.readers(me, id ?? ""),
    queryFn: () => api.vault.listReaders(id!),
    enabled: !!id,
  });
}

/** Persone e ruoli del progetto con cui condividere (vuoto senza `credentials.share`). */
export function useShareTargets(id: string | undefined, enabled: boolean) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.shareTargets(me, id ?? ""),
    queryFn: () => api.vault.listShareTargets(id!),
    enabled: !!id && enabled,
  });
}

/** «Share»: con la cassaforte aperta (la prova e le copie le fa il livello dati). */
export function useShare() {
  return useWrite(
    ({ id, target }: { id: string; target: ReaderTarget }) => api.vault.share(id, target),
    VAULT_AREAS,
  );
}

/** «Remove» di un lettore diretto, con la cassaforte aperta. */
export function useRemoveReader() {
  return useWrite(
    ({ id, readerId }: { id: string; readerId: string }) => api.vault.removeReader(id, readerId),
    VAULT_AREAS,
  );
}

/** Una credenziale nuova (non chiede la cassaforte aperta: le copie le dà il livello dati). */
export function useCreateCredential() {
  return useWrite(
    ({ projectId, input }: { projectId: string; input: api.vault.CredentialInput }) =>
      api.vault.createCredential(projectId, input),
    VAULT_AREAS,
    // Le variabili portano la password: la cache delle mutazioni non le tiene (review I3).
    { secret: true },
  );
}

/** La modifica: i campi in chiaro; una password nuova vuole la cassaforte aperta. */
export function useUpdateCredential() {
  return useWrite(
    ({ id, input }: { id: string; input: Partial<api.vault.CredentialInput> }) =>
      api.vault.updateCredential(id, input),
    VAULT_AREAS,
    { secret: true },
  );
}

/** «Delete…» di una credenziale (con `canEdit`): lettori e copie se ne vanno con lei. */
export function useDeleteCredential() {
  return useWrite((id: string) => api.vault.deleteCredential(id), VAULT_AREAS);
}

/** «Copy»: gli appunti li scrive il livello dati (nell'app, il main). */
export function useCopyPassword() {
  return useWrite((id: string) => api.vault.copy(id), VAULT_AREAS);
}
