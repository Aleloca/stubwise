import { useQueries, useQuery } from "@tanstack/react-query";
import { projectSettingsAccess, type SectionAccess } from "../adminSections";
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
  ProjectResult,
  ProjectSettingsView,
  ProjectSwitch,
  ProjectUsageDimension,
} from "../projectSettings";
export {
  CORRECTION_CAP_MAX,
  CORRECTION_CAP_MIN,
  DESCRIPTION_MAX,
  NAME_MAX,
  PROJECT_SWITCHES,
  PULSE_DAYS_MAX,
  PULSE_DAYS_MIN,
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
