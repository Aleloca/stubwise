import { useQueries, useQuery } from "@tanstack/react-query";
import { canSeeAdminSection, projectSettingsAccess, type SectionAccess } from "../adminSections";
import * as api from "../api";
import { PROJECT_AREAS, useSessionPersonId, useWrite } from "../queries";
import type { ProjectSettingsSection } from "../routes";
import { useViewer } from "../viewer";

// Gli hook di Progetto → Settings (area 9c); `data/queries` li ri-esporta.
// L'import circolare con `../queries` è innocuo: gli helper si usano solo
// dentro le funzioni (per questo le aree che nominano `PROJECT_AREAS` sono
// funzioni, non costanti di modulo). Le letture stanno nell'area «projectSettings»; ogni
// scrittura la ricarica insieme al registro e a ciò che il cambio tocca
// altrove. I Task 4, 5 ci aggiungono i loro.

export type {
  EnvFileView,
  IntegrationView,
  ProjectResult,
  ProjectSettingsView,
  ProjectSwitch,
  ProjectUsageDimension,
  RemoteRepository,
  RepositoryView,
} from "../projectSettings";
export {
  CORRECTION_CAP_MAX,
  CORRECTION_CAP_MIN,
  DESCRIPTION_MAX,
  NAME_MAX,
  PROJECT_SWITCHES,
  PULSE_DAYS_MAX,
  PULSE_DAYS_MIN,
  pulseNeedsBacklogFor,
  reviewAccountChoices,
} from "../projectSettings";

export type { SectionAccess } from "../adminSections";

/**
 * Chi vede e chi scrive le sezioni di Settings del progetto, come le dice il
 * livello dati (`projectSettingsAccess`): la colonna, «View only» e le
 * pagine delle impostazioni leggono da qui, mai `can()` (ruling del
 * controller (pre-flight), P13). Si rilegge a ogni cambio di persona o di
 * permessi (il contesto di chi guarda cambia).
 */
export function useProjectSettingsAccess(
  projectId: string,
): Record<ProjectSettingsSection, SectionAccess> {
  return projectSettingsAccess(useViewer().viewer, projectId);
}

const SETTINGS_AREAS: readonly string[] = ["projectSettings", "changelog"];
/** Il nome del progetto si legge ovunque: binario, testate, ⌘K, liste. */
const generalWriteAreas = (): readonly string[] => [
  ...SETTINGS_AREAS,
  ...PROJECT_AREAS,
  "conversations",
  "conversation",
  "search",
];
/** L'account del progetto lo leggono le partenze del lavoro di Claude (Task 6). */
const AI_WRITE_AREAS: readonly string[] = [...SETTINGS_AREAS, "conversations", "task"];
/** Interruttori e tetto si vedono nel polso, nelle PR, nei Docs, nei report e nel brief (Task 6). */
const automationsWriteAreas = (): readonly string[] => [
  ...SETTINGS_AREAS,
  ...PROJECT_AREAS,
  "releases",
  "docs",
  "dailyReports",
  "latestBrief",
];

/** Le impostazioni di General, AI e Automations; `null` su un progetto invisibile o archiviato. */
export function useProjectSettings(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "projectSettings", "settings", projectId] as const,
    queryFn: () => api.projectSettings.getProjectSettings(projectId),
  });
}

/**
 * Gli interruttori del progetto (Task 6): le frasi «off» di brief, Docs
 * notturni, pulse e report. Stessa area delle impostazioni: un salvataggio
 * in Automations la ricarica, senza ricaricare la pagina.
 */
export function useProjectSwitches(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "projectSettings", "switches", projectId] as const,
    queryFn: () => api.projectSettings.getProjectSwitches(projectId),
  });
}

/** Gli interruttori di più progetti (le righe del report in Activity), per id. */
export function useProjectsSwitches(projectIds: readonly string[]) {
  const me = useSessionPersonId();
  return useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["as", me, "projectSettings", "switches", projectId] as const,
      queryFn: () => api.projectSettings.getProjectSwitches(projectId),
    })),
    combine: (results) =>
      new Map(projectIds.map((id, i) => [id, results[i]?.data ?? undefined] as const)),
  });
}

export function useUpdateProjectGeneral() {
  return useWrite(
    ({ projectId, ...input }: { projectId: string; name?: string; description?: string }) =>
      api.projectSettings.updateProjectGeneral(projectId, input),
    generalWriteAreas(),
  );
}

export function useSetProjectAi() {
  return useWrite(
    ({
      projectId,
      ...input
    }: {
      projectId: string;
      providerId: string | null;
      exclusive: boolean;
    }) => api.projectSettings.setProjectAi(projectId, input),
    AI_WRITE_AREAS,
  );
}

export function useSaveProjectAutomations() {
  return useWrite(
    ({
      projectId,
      ...input
    }: { projectId: string } & Parameters<typeof api.projectSettings.saveProjectAutomations>[1]) =>
      api.projectSettings.saveProjectAutomations(projectId, input),
    automationsWriteAreas(),
  );
}

/** I consumi del progetto (errore `forbidden` senza `project.usage.view`; `null` se invisibile). */
export function useProjectUsage(
  projectId: string,
  input: Parameters<typeof api.projectSettings.getProjectUsage>[1],
) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "projectSettings", "usage", projectId, input] as const,
    queryFn: () => api.projectSettings.getProjectUsage(projectId, input),
  });
}

// --- Repositories (Task 8) ---------------------------------------------------
//
// Gli hook del Task 4 (ruling del controller (pre-flight), P26). Un
// repository si legge anche altrove: negli spazi dei Docs (il nome), in
// Amministrazione → Repositories e Git accounts (chi usa un account), nelle
// parti dell'8a (Releases): creare e modificare ricaricano anche quelle.

/** Dove si legge un repository oltre che qui. */
const REPOSITORY_WRITE_AREAS: readonly string[] = [...SETTINGS_AREAS, "docs", "instance", "releases"];

/** I repository del progetto; `null` senza `repos.view` o su un progetto invisibile o archiviato. */
export function useProjectRepositories(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "projectSettings", "repositories", projectId] as const,
    queryFn: () => api.projectSettings.listProjectRepositories(projectId),
  });
}

/** I repository che un account vede (passo 2 della creazione), con quelli già nel progetto. */
export function useRemoteRepositories(accountId: string | null, projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "projectSettings", "remote", accountId, projectId] as const,
    queryFn: () => api.projectSettings.listRemoteRepositories(accountId!, projectId),
    enabled: accountId !== null,
  });
}

/** La verifica degli accessi della creazione guidata: non è una modifica, nessuna voce. */
export function useCheckRepositoryAccess() {
  return useWrite(
    (input: Parameters<typeof api.projectSettings.checkRepositoryAccess>[0]) =>
      api.projectSettings.checkRepositoryAccess(input),
    [],
  );
}

export function useCreateRepository() {
  return useWrite(
    ({
      projectId,
      ...input
    }: { projectId: string } & Parameters<typeof api.projectSettings.createRepository>[1]) =>
      api.projectSettings.createRepository(projectId, input),
    REPOSITORY_WRITE_AREAS,
  );
}

export function useUpdateRepository() {
  return useWrite(
    ({
      repositoryId,
      ...patch
    }: { repositoryId: string } & Parameters<typeof api.projectSettings.updateRepository>[1]) =>
      api.projectSettings.updateRepository(repositoryId, patch),
    REPOSITORY_WRITE_AREAS,
  );
}

export function useConfigureRepositoryWebhook() {
  return useWrite(
    (repositoryId: string) => api.projectSettings.configureRepositoryWebhook(repositoryId),
    REPOSITORY_WRITE_AREAS,
  );
}

/** SOLO PROTOTIPO: l'esito della prossima verifica degli accessi. */
export function useSimulateNextRepositoryCheck() {
  return useWrite(
    (outcome: Parameters<typeof api.projectSettings.simulateNextRepositoryCheck>[0]) =>
      api.projectSettings.simulateNextRepositoryCheck(outcome),
    [],
  );
}

/** SOLO PROTOTIPO: come finisce la prossima configurazione del webhook. */
export function useSimulateNextWebhookSetup() {
  return useWrite(
    (outcome: "configured" | "failed") => api.projectSettings.simulateNextWebhookSetup(outcome),
    [],
  );
}

/**
 * Se chi guarda vede Amministrazione → Git accounts: senza account la
 * creazione guidata ci porta con un link, oltre al «Who?».
 */
export function useSeesGitAccounts(): boolean {
  return canSeeAdminSection(useViewer().viewer, "git-accounts");
}

// --- File d'ambiente e Integration (Task 9) ----------------------------------
//
// Le scritture con un segreto negli argomenti (un valore d'ambiente, il testo
// importato) o nel risultato (la chiave d'ingestione, il secret del webhook)
// hanno `{ secret: true }`: la cache delle mutazioni non le tiene (shape
// project-repositories.md §7). Chi le usa le monta nel dialogo che mostra o
// raccoglie il valore, così il risultato sparisce con lui.

/** I file d'ambiente di un repository; errore `forbidden` senza `repos.manage`. */
export function useEnvFiles(repositoryId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "projectSettings", "envFiles", repositoryId] as const,
    queryFn: () => api.projectSettings.listEnvFiles(repositoryId),
  });
}

/** Un file vuoto: nessun segreto. */
export function useCreateEnvFile() {
  return useWrite(
    ({
      repositoryId,
      ...input
    }: { repositoryId: string } & Parameters<typeof api.projectSettings.createEnvFile>[1]) =>
      api.projectSettings.createEnvFile(repositoryId, input),
    SETTINGS_AREAS,
  );
}

export function useImportEnvFile() {
  return useWrite(
    ({ fileId, content }: { fileId: string; content: string }) =>
      api.projectSettings.importEnvFile(fileId, content),
    SETTINGS_AREAS,
    { secret: true },
  );
}

export function useSetEnvVar() {
  return useWrite(
    ({ fileId, key, value }: { fileId: string; key: string; value: string }) =>
      api.projectSettings.setEnvVar(fileId, key, value),
    SETTINGS_AREAS,
    { secret: true },
  );
}

export function useRemoveEnvVar() {
  return useWrite(
    ({ fileId, key }: { fileId: string; key: string }) =>
      api.projectSettings.removeEnvVar(fileId, key),
    SETTINGS_AREAS,
    { secret: true },
  );
}

export function useDeleteEnvFile() {
  return useWrite(
    (fileId: string) => api.projectSettings.deleteEnvFile(fileId),
    SETTINGS_AREAS,
    { secret: true },
  );
}

/** Integration come la legge chi guarda; `null` su un progetto invisibile o archiviato. */
export function useProjectIntegration(projectId: string) {
  const me = useSessionPersonId();
  return useQuery({
    queryKey: ["as", me, "projectSettings", "integration", projectId] as const,
    queryFn: () => api.projectSettings.getIntegration(projectId),
  });
}

export function useRegenerateIngestionKey() {
  return useWrite(
    (projectId: string) => api.projectSettings.regenerateIngestionKey(projectId),
    SETTINGS_AREAS,
    { secret: true },
  );
}

/** Il secret del webhook si legge anche nella pagina del repository (le ultime 4). */
export function useRegenerateWebhookSecret() {
  return useWrite(
    (repositoryId: string) => api.projectSettings.regenerateWebhookSecret(repositoryId),
    REPOSITORY_WRITE_AREAS,
    { secret: true },
  );
}
