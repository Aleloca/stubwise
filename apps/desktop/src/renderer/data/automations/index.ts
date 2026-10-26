// Le Automations (area 7) come le espone `api.ts`: `api.automations.<funzione>`.
// Chi vede che cosa lo decide `visibility.ts`; gli effetti li esegue solo
// `effects.ts`, a nome del proprietario; `runner.ts` fa avanzare le
// esecuzioni col motore puro; `sources.ts` aggancia gli inizi di Stubwise
// alle scritture di oggi (importarlo registra l'ascolto); `simulate.ts` è
// la prova, che usa lo stesso motore e non scrive mai nello store.
import "./sources";

export {
  getAutomation,
  getRun,
  listAutomations,
  listClientLinks,
  listMyApprovals,
  listRuns,
  listSources,
  searchAutomations,
} from "./reads";
export {
  activate,
  advanceTime,
  approve,
  cancelRun,
  chooseProject,
  connectSource,
  createAutomation,
  deleteDraft,
  disconnectSource,
  pause,
  publish,
  reject,
  removeClientLink,
  retryStep,
  runDueSchedules,
  saveDraft,
  setClientLink,
  simulateSourceEvent,
  skipStep,
  startManual,
} from "./writes";
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
