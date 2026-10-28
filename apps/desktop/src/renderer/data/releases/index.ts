// Rilasci, PR e ambienti (area 8a) come li espone `api.ts`:
// `api.releases.<funzione>`. Chi vede che cosa e gli stati derivati li
// decide `visibility.ts` con le regole pure di `domain/releases`; il merge è
// l'unica azione su un rilascio (anti-obiettivo 1: nessun deploy, nessun
// «riprova la pipeline» — lo verifica un test sull'insieme esportato).
// `simulate.ts` esiste solo nel prototipo.

export {
  getRelease,
  getRepositorySettings,
  listEnvironments,
  listMyReleases,
  listOpenPrs,
  listReleaseQueue,
  listReleases,
  searchReleases,
  type EnvironmentList,
  type MyReleases,
  type ReleaseSearchResult,
  type RepositorySettings,
} from "./reads";
export {
  createEnvironment,
  deleteEnvironment,
  explainRelease,
  fixRelease,
  mergePr,
  requestPrCorrection,
  setPrAnalysisOnly,
  setReleasePipeline,
  setRepoPrMode,
  updateEnvironment,
  type CorrectionRequestResult,
  type EnvironmentInput,
  type MergeError,
  type MergeResult,
} from "./writes";
export {
  advancePrWork,
  simulateAuthorPush,
  simulateRunOutcome,
  simulateSeenOnServer,
} from "./simulate";
export type { OpenPrView, QueueItem, ReleaseView, RunView } from "./visibility";
