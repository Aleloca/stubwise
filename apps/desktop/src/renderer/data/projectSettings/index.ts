// Le impostazioni di progetto (area 9c) come le espone `api.ts`:
// `api.projectSettings.<funzione>`. I Task 2–5 ci aggiungono le loro
// funzioni (General, AI, Automations, Usage, Repositories, file
// d'ambiente, Integration, Plugins, Archive). `changeTypes.ts` si importa per
// il suo effetto: registra i tipi di voce del registro prima della prima
// scrittura (P5). Lo stato (`state.ts`) e il seme (`seed.ts`) non si
// esportano come valori: li legge solo il livello dati.
import "./changeTypes";

export {
  CORRECTION_CAP_MAX,
  CORRECTION_CAP_MIN,
  PROJECT_SWITCHES,
  PULSE_DAYS_MAX,
  PULSE_DAYS_MIN,
  pulseNeedsBacklogFor,
  type DeletedProject,
  type ProjectPluginChoices,
  type ProjectSettings,
  type ProjectSwitch,
} from "./state";
export type { BusyReason, ProjectRefusal, ProjectResult } from "./types";
// Task 2: General, AI, Automations, Usage.
export {
  getProjectSettings,
  getProjectSwitches,
  projectSwitchOn,
  type ProjectSettingsView,
} from "./reads";
export { DESCRIPTION_MAX, NAME_MAX, updateProjectGeneral } from "./general";
export { setProjectAi } from "./ai";
export { saveProjectAutomations } from "./automations";
export { getProjectUsage, type ProjectUsageDimension } from "./usage";
// Task 4: Repositories, file d'ambiente, Integration, Plugins.
export {
  checkRepositoryAccess,
  configureRepositoryWebhook,
  createRepository,
  listProjectRepositories,
  listRemoteRepositories,
  reviewAccountChoices,
  simulateNextRepositoryCheck,
  simulateNextWebhookSetup,
  updateRepository,
  type RemoteRepository,
  type RepositoryView,
} from "./repositories";
export {
  createEnvFile,
  deleteEnvFile,
  importEnvFile,
  listEnvFiles,
  removeEnvVar,
  setEnvVar,
  type EnvFileView,
} from "./envFiles";
export {
  getIntegration,
  regenerateIngestionKey,
  regenerateWebhookSecret,
  type IntegrationView,
} from "./integration";
export {
  BASE_PLUGIN,
  RECOMMENDED_PRESETS,
  getProjectPlugins,
  saveProjectPlugins,
  skillsForRun,
  type ProjectPluginsView,
} from "./plugins";
// Task 5: archivia, riapri, elimina.
export {
  archiveProject,
  busyReasonsOf,
  deleteProject,
  getArchivePreview,
  getArchivedProject,
  getDeletionPreview,
  listArchivedProjects,
  reopenProject,
  type ArchivedProjectRow,
  type ArchivedProjectView,
  type DeletionCountKey,
  type DeletionCounts,
} from "./archive";
