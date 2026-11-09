// Il livello dati della build «app» (integrazione area 2, fetta 1): lo stesso
// insieme di nomi di `data/api.ts`, risolto da `@backend/api` quando
// `STUBWISE_BUILD=app` (`vite.backend.ts`). Parte dagli stub «non integrati»
// generati; un'esportazione locale qui sotto prevale sulla stella, ed è
// tipata `typeof Fake.<nome>` con un `import type`, così il finto non entra
// mai nel bundle.
import type * as Fake from "../../api";
import { adminDepartments } from "./departments";
import { partialNamespace } from "./notIntegrated";

export * from "./stubs.generated";

// Task 16: sessione, persone, progetti, notifiche, ricerca, reparti.
export { auth, getSessionPerson, getViewer, me } from "./session";
export { listDepartments, listPeople } from "./people";
export {
  getProjectByCode,
  listPinnedProjectIds,
  listProjects,
  listWaitingOnMeProjectIds,
  setPinned,
} from "./projects";
export { listNotifications, markNotification } from "./notifications";
export { search } from "./search";

/** Amministrazione: solo Reparti (e le persone che la pagina legge) nella fetta 1. */
export const admin: typeof Fake.admin = partialNamespace<typeof Fake.admin>("admin", adminDepartments);

// Task 17: Tasks, dettaglio, nuova task, stati, allegati.
export {
  bulkUpdateTasks,
  clearManualStall,
  countTasks,
  createTask,
  followTask,
  getTaskByCode,
  listStalled,
  listTasks,
  tasksTruncated,
  setManualStall,
  updateTask,
} from "./tasks";
export {
  addComment,
  addLink,
  answerDecision,
  askDecision,
  deleteComment,
  editComment,
  getRequest,
  getTaskWorkSummary,
  listActivity,
  listDecisionRequests,
  removeLink,
  withdrawDecision,
} from "./taskDetail";
export { listMilestones, listProjectStatuses, setProjectStatuses, setStallThresholds } from "./statuses";
export { addAttachment, removeAttachment } from "./attachments";
export { listDayArrangements, planTask, setDay } from "./planning";
export { convertRequest, listRequestsToConvert } from "./requests";
export { createMilestone, deleteMilestone, updateMilestone } from "./milestones";
export {
  getLatestBrief,
  listDecisionLog,
  listPortfolioActivityPage,
  listProjectPulses,
  listTimelinePage,
  projectPulse,
  recordDecision,
  setDecisionSuperseded,
} from "./overview";
export {
  getPersonalHome,
  listDepartmentHomes,
  listDepartmentRoles,
  markDepartmentHomeSeen,
  resetPersonalHome,
  setDepartmentHome,
  setPersonalHome,
} from "./home";
export {
  deleteFilter,
  getSavedFilter,
  listPinnedFilterIds,
  listSavedFilters,
  saveFilter,
  setFilterPinned,
  updateFilter,
} from "./filters";
