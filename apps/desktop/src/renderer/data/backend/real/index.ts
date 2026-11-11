// Il livello dati della build «app» (integrazione area 2, fetta 1): lo stesso
// insieme di nomi di `data/api.ts`, risolto da `@backend/api` quando
// `STUBWISE_BUILD=app` (`vite.backend.ts`). Parte dagli stub «non integrati»
// generati; un'esportazione locale qui sotto prevale sulla stella, ed è
// tipata `typeof Fake.<nome>` con un `import type`, così il finto non entra
// mai nel bundle.
import type * as Fake from "../../api";
import { adminDepartments } from "./departments";
import { partialNamespace } from "./notIntegrated";
import { chatFunctions } from "./chat";
import { channelStream, onChatChange, subscribeChat, threadStream } from "./chatStream";

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
// Chat, fetta 3: le decisioni sulle proposte di Claude e «Undo» dei suoi gruppi.
export { cancelProposal, confirmProposal, editProposal, settlePageEvent } from "./claudeChatActions";
import { claudeChatNamespace } from "./claudeChatActions";
export const claude: typeof Fake.claude = partialNamespace<typeof Fake.claude>("claude", claudeChatNamespace);
// Dell'istanza la chat legge solo il budget del mese (la casella si spegne con la sua frase).
export { instance } from "./instanceChat";
// Area 4, fetta 1: la Chat fra persone (canali di progetto, messaggi, menzioni,
// lo stream); DM, privati, ricerca, domande, @Claude ed eventi restano «non integrati».
// I Docs (area 5, fetta 1): le letture, poi le scritture e il grafo (`docs.ts`).
export { docs } from "./docs";
// Il Drive (area 5, fetta 2): i caricati, senza Google né contenuto (`drive.ts`).
export { drive } from "./drive";
export const chat: typeof Fake.chat = partialNamespace<typeof Fake.chat>("chat", {
  ...chatFunctions,
  channelStream,
  threadStream,
  subscribeChat,
  onChatChange,
});

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
  getTaskWorkSummary,
  listActivity,
  listDecisionRequests,
  removeLink,
  withdrawDecision,
} from "./taskDetail";
export { listMilestones, listProjectStatuses, setProjectStatuses, setStallThresholds } from "./statuses";
export { addAttachment, downloadTaskAttachment, removeAttachment } from "./attachments";
export { listDayArrangements, planTask, setDay } from "./planning";
export {
  archiveRequest,
  convertRequest,
  createRequest,
  getRequest,
  getRequestByCode,
  listRequests,
  listRequestsToConvert,
  mergeRequest,
  reopenRequest,
  restoreRequest,
  updateRequest,
} from "./requests";
export { createMilestone, deleteMilestone, updateMilestone } from "./milestones";
export { createProject } from "./projects";
export {
  getLatestBrief,
  decisionLogTruncated,
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

// Integrazione area 3, fetta 3a «Guardare»: le sessioni di lavoro di Claude in
// lettura, lo stream dal vivo e il lavoro della task.
export { getConversation, getTaskWork, listConversations } from "./claude";
export { mergeStreamEvent, onConversationChange, reconnectDelay, subscribe } from "./claudeStream";
// Fetta 3b «Agire»: le azioni (i permessi li decide il server) e «Da decidere» di Claude.
export {
  answerQuestion,
  cancelRun,
  decidePlan,
  listClaudeDecisions,
  preApprovePlan,
  relaunchWithInstructions,
  requestChanges,
  resumeCorrection,
  revokePlanApproval,
  sendMessage,
  startRun,
  stop,
  stopAndSend,
} from "./claudeActions";
// Fetta 3d: «By person» di Activity (lo standup aggregato dal server) e i report del giorno.
export { generateDailyReport, linkCommitAuthor, listDailyReports, listPeopleActivity } from "./peopleActivity";
// Fetta 3c: il refinement delle richieste.
export { closeRefine, getRefineOf, startRefineConversation } from "./claudeRefine";
// La chat con Claude, fetta 2: le conversazioni libere private (solo «Mine»).
export {
  archiveConversation,
  contextIdOf,
  continueConversation,
  createConversation,
  deleteConversation,
  describeContext,
  listCommands,
  renameConversation,
  resolveCitations,
  resolveCodes,
  searchMentions,
  setConversationContext,
  // Fetta 5: le pubbliche e la continuazione.
  setVisibility,
} from "./claudeChat";
// Fetta 3.0 della chat: «Elimina task» (anteprima ed eliminazione dal server).
export { deleteTask, getTaskDeletion } from "./taskDelete";
