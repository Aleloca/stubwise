// Le Automations (area 7) come le espone `api.ts`: `api.automations.<funzione>`.
// Chi vede che cosa lo decide `visibility.ts`; gli effetti li esegue solo
// `effects.ts`, a nome del proprietario; `runner.ts` fa avanzare le
// esecuzioni col motore puro; `sources.ts` aggancia gli inizi di Stubwise
// alle scritture di oggi (importarlo registra l'ascolto); `simulate.ts` è
// la prova, che usa lo stesso motore e non scrive mai nello store.
import "./sources";

export {
  checkDraft,
  getAutomation,
  getRun,
  listAutomations,
  listClientLinks,
  listMyApprovals,
  listRuns,
  listSources,
  searchAutomations,
} from "./reads";
export { automationOrigin, getProjectAutomations, listMyRuns } from "./entry";
export {
  activate,
  createAutomation,
  deleteDraft,
  duplicateAutomation,
  pause,
  publish,
  renameAutomation,
  saveDraft,
} from "./writes";
export {
  advanceTime,
  approve,
  cancelRun,
  chooseProject,
  reject,
  retryStep,
  skipStep,
  startManual,
} from "./runWrites";
export {
  connectSource,
  disconnectSource,
  removeClientLink,
  runDueSchedules,
  setClientLink,
  simulateSourceEvent,
} from "./sourceWrites";
export { listSimulationExamples } from "./examples";
export {
  createWebhookSource,
  listClientSuggestions,
  previewWebhookExample,
  regenerateWebhookAddress,
  renameSource,
  setWebhookExample,
  updateWebhookField,
} from "./webhooks";
export {
  endSimulation,
  getSimulation,
  SimulationConfigError,
  simulationStep,
  startSimulation,
  type SimulationInput,
} from "./simulate";
export { MAX_ACTIVE_RUNS, whenAutomationsIdle } from "./runner";
export { canManageAutomation, canSeeAutomation } from "./visibility";
