import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import type { PeopleFilter } from "../admin/types";
import type { ChangeFilter } from "../changelog/types";
import { queryKeys, useSessionPersonId, useWrite } from "../queries";

// Gli hook dell'amministrazione e della riconferma (area 9a); `data/queries`
// li ri-esporta. L'import circolare con `../queries` è innocuo: gli helper si
// usano solo dentro le funzioni.

export type { ChangeEntryView, ChangeFilter } from "../changelog/types";
export type { SecondFactorInput, SecondFactorResult, TotpSetup } from "../auth/reauth";
export type * from "../admin/types";
/** Le otto tinte dei reparti, nell'ordine di `DESIGN.md`: il dialogo e il pannello del reparto. */
export { DEPARTMENT_COLORS } from "../admin/departments";

/** Il registro delle modifiche in Amministrazione: le voci che chi guarda legge. */
export function useChanges(filter: ChangeFilter = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.changes(me, filter),
    queryFn: () => api.changelog.listChanges(filter),
  });
}

/**
 * Il registro di un progetto (Settings → Change log). Errore `not_found` per
 * un progetto nascosto o inesistente (R-G5), `forbidden` per chi non lo gestisce.
 */
export function useProjectChanges(
  projectId: string | undefined,
  filter: Omit<ChangeFilter, "projectId"> = {},
) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.projectChanges(me, projectId ?? "", filter),
    queryFn: () => api.changelog.listProjectChanges(projectId!, filter),
    enabled: !!projectId,
  });
}

/**
 * Il dialogo «Confirm it's you»: verifica il secondo fattore. Non cambia
 * nessuna lettura (apre solo la finestra di grazia), quindi non ricarica
 * niente; l'azione che l'ha aperto si ripete da sé.
 */
export function useReauthenticate() {
  return useWrite(api.auth.reauthenticate, []);
}

/** L'iscrizione al volo dentro la riconferma: il segreto TOTP, una volta. */
export function useEnrollDuringReauth() {
  return useWrite(() => api.auth.enrollDuringReauth(), []);
}

/**
 * Il primo codice dell'iscrizione al volo: accende il secondo fattore, dà i
 * codici di backup (una volta) e vale come riconferma.
 */
export function useConfirmEnrollment() {
  return useWrite(api.me.confirmTotp, []);
}

/**
 * Quali modi ha chi guarda per riconfermarsi: il dialogo «Confirm it's you»
 * sceglie da qui fra il codice e l'iscrizione al volo, e mostra «Use a
 * passkey» e «Use a backup code» solo a chi ne ha. Campi già calcolati.
 */
export function useMySecondFactor(enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "mySecondFactor"),
    queryFn: () => api.me.getMySecurity(),
    select: (s) => ({
      on: s.on,
      passkeys: s.passkeys.length,
      backupCodesLeft: s.backupCodesLeft,
    }),
    enabled,
    // Ogni apertura del dialogo rilegge, senza mostrare la risposta di prima:
    // un'iscrizione appena fatta la cambia.
    gcTime: 0,
  });
}

// --- Amministrazione (area 9a, Task 4) ----------------------------------------

/**
 * Una scrittura d'amministrazione. Cambia cosa possono fare le persone —
 * anche chi la fa — quindi alla fine ricarica TUTTE le query, di ogni persona
 * (quelle attive ripartono, le altre alla prossima lettura). Il
 * `ViewerProvider` si rinfresca da sé: ascolta la versione degli accessi.
 * Il risultato è un dato (`AdminResult`): un rifiuto non è un errore della
 * mutazione, lo è solo un guasto del livello dati.
 */
export function useAdminWrite<TVars, TData>(mutationFn: (vars: TVars) => Promise<TData>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => client.invalidateQueries({ queryKey: ["as"] }),
  });
}

/**
 * People: le persone (e, per chi invita, gli inviti in sospeso). Cambiando
 * filtro resta l'elenco di prima finché arriva il nuovo (niente scheletro a
 * ogni lettera scritta nella ricerca).
 */
export function useAdminPeople(filter: PeopleFilter = {}) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "people", filter),
    queryFn: () => api.admin.listPeople(filter),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === me ? previous : undefined,
  });
}

/** La pagina di una persona; `not_found` per Claude o un id sconosciuto. */
export function useAdminPerson(personId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "person", personId ?? ""),
    queryFn: () => api.admin.getPerson(personId!),
    enabled: !!personId,
  });
}

/** Il registro della sicurezza di una persona (`users.manage`). */
export function useSecurityEvents(personId: string | undefined, enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "securityEvents", personId ?? ""),
    queryFn: () => api.admin.listSecurityEvents(personId!),
    enabled: !!personId && enabled,
  });
}

/** Gli autori git osservati e non collegati (il campo «Link a git email»). */
export function useObservedAuthors(enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "observedAuthors"),
    queryFn: () => api.admin.listObservedAuthors(),
    enabled,
  });
}

export function useInvites(enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "invites"),
    queryFn: () => api.admin.listInvites(),
    enabled,
  });
}

/** Le scelte di «Invite someone» (`users.invite`): ruoli e progetti con ciò che manca. */
export function useInviteChoices(enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "inviteChoices"),
    queryFn: () => api.admin.getInviteChoices(),
    enabled,
  });
}

export function useRoles() {
  const me = useSessionPersonId();
  return useQuery({ queryKey: queryKeys.admin(me, "roles"), queryFn: () => api.admin.listRoles() });
}

/** I reparti con persone, Home e permessi (`departments.manage`). */
export function useAdminDepartments(enabled = true) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "departments"),
    queryFn: () => api.admin.listDepartments(),
    enabled,
  });
}

/** Members del progetto; `not_found` per un progetto che chi guarda non vede. */
export function useMembers(projectId: string | undefined) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: queryKeys.admin(me, "members", projectId ?? ""),
    queryFn: () => api.admin.listProjectMembers(projectId!),
    enabled: !!projectId,
  });
}

/**
 * Una funzione dell'API d'amministrazione come mutazione: le variabili sono i
 * suoi argomenti, il dato il suo esito (tipato: `mutateAsync` lo restituisce
 * a `useReauth`, che lo passa al chiamante).
 */
const adminWrite = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  function useIt() {
    return useAdminWrite((args: A) => fn(...args));
  };

export const useSetInstanceRole = adminWrite(api.admin.setInstanceRole);
export const useCreatePasswordResetLink = adminWrite(api.admin.createPasswordResetLink);
export const useResetSecondFactor = adminWrite(api.admin.resetSecondFactor);
export const useLinkGitIdentity = adminWrite(api.admin.linkGitIdentity);
export const useUnlinkGitIdentity = adminWrite(api.admin.unlinkGitIdentity);
export const useSetBitbucketUsername = adminWrite(api.admin.setBitbucketUsername);
export const useDeactivatePerson = adminWrite(api.admin.deactivatePerson);
export const useReactivatePerson = adminWrite(api.admin.reactivatePerson);
export const useCreateInvite = adminWrite(api.admin.createInvite);
export const useRevokeInvite = adminWrite(api.admin.revokeInvite);
export const useCreateRole = adminWrite(api.admin.createRole);
export const useUpdateRole = adminWrite(api.admin.updateRole);
export const useDuplicateRole = adminWrite(api.admin.duplicateRole);
export const useDeleteRole = adminWrite(api.admin.deleteRole);
export const useCreateDepartment = adminWrite(api.admin.createDepartment);
export const useUpdateDepartment = adminWrite(api.admin.updateDepartment);
export const useSetDepartmentMembers = adminWrite(api.admin.setDepartmentMembers);
export const useSetHomeManagers = adminWrite(api.admin.setHomeManagers);
export const useSetDepartmentPermissions = adminWrite(api.admin.setDepartmentPermissions);
export const useDeleteDepartment = adminWrite(api.admin.deleteDepartment);
export const useAddMember = adminWrite(api.admin.addMember);
export const useRemoveMember = adminWrite(api.admin.removeMember);
export const useSetMemberRole = adminWrite(api.admin.setMemberRole);
export const useGrantMemberPermission = adminWrite(api.admin.grantMemberPermission);
export const useRevokeMemberPermission = adminWrite(api.admin.revokeMemberPermission);
