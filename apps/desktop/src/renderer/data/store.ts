import { prLines, type PrLine } from "../domain/claude/taskWork";
import { stallOf, type Stall } from "../domain/stalled";
import { currentWeek } from "../domain/weeks";
import { matches, type FilterContext } from "../domain/filters";
import { ACTIVITY } from "./seed/activity";
import { BRIEFS } from "./seed/briefs";
import {
  CHAT_CHANNELS,
  CHAT_MESSAGES,
  CHAT_NOTIFICATIONS,
  CHAT_NOTIFY_PREFS,
  CHAT_READ_STATES,
  RELEASE_PAGES,
} from "./seed/chat";
import { CONVERSATION_EVENTS, CONVERSATIONS } from "./seed/conversations";
import { TODAY } from "./seed/dates";
import { DECISION_LOG } from "./seed/decisionLog";
import { DECISION_REQUESTS } from "./seed/decisions";
import { INITIAL_PINNED_FILTERS, SAVED_FILTERS } from "./seed/filters";
import { DAY_ARRANGEMENTS, DEPARTMENT_HOMES, PERSONAL_HOMES } from "./seed/homes";
import { MILESTONES } from "./seed/milestones";
import { NOTIFICATIONS } from "./seed/notifications";
import { INITIAL_PINNED_CODES, PROJECTS } from "./seed/projects";
import { REQUESTS } from "./seed/requests";
import { PROJECT_STATUSES } from "./seed/statuses";
import { TASKS } from "./seed/tasks";
import { DAILY_REPORTS, PR_FACTS, PULL_REQUEST_EVENTS } from "./seed/timeline";
import { DOC_PAGES } from "./seed/docPages";
import { DOC_SPACES } from "./seed/docs/spaces";
import {
  DRIVE_FILES,
  DRIVE_HIDDEN,
  DRIVE_OPENS,
  FOLDER_LINKS,
  GOOGLE_ACCOUNTS,
  GOOGLE_DRIVE_FILES,
  GOOGLE_FOLDERS,
  GOOGLE_OUTSIDE_FILES,
} from "./seed/drive";
import {
  MAILBOXES,
  MAIL_DRAFTS,
  MAIL_INCOMING,
  MAIL_MESSAGES,
  MAIL_PROPOSALS,
  MEETING_TRANSCRIPTS,
} from "./seed/mail";
import {
  CALENDAR_EVENTS,
  CALENDAR_PROPOSALS,
  CALENDAR_SERIES,
  CALENDAR_SYNC,
} from "./seed/calendar";
import {
  AUTOMATIONS,
  AUTOMATION_RUNS,
  AUTOMATION_SOURCES,
  CLIENT_PROJECT_LINKS,
} from "./seed/automations";
import { DEFAULT_SESSION_PERSON_ID, getSessionPersonId, setSessionPersonId } from "./session";
import type {
  ActivityEntry,
  AppNotification,
  Automation,
  AutomationRun,
  AutomationSource,
  ClientProjectLink,
  Channel,
  ChatMessage,
  Conversation,
  ConversationActivity,
  ConversationEvent,
  ConversationKind,
  ConversationPermissions,
  ConversationRow,
  DailyReport,
  DayArrangement,
  DecisionLogEntry,
  DecisionRequest,
  FilterCriteria,
  DepartmentHome,
  Milestone,
  PersonalHome,
  Project,
  ProjectPulse,
  ProjectRequest,
  ProjectStatus,
  PrFact,
  PrRef,
  PullRequestEvent,
  NotifyLevel,
  ReadOnlyReason,
  ReadState,
  ReleasePage,
  DocGeneration,
  DocPage,
  DocSpace,
  ContentState,
  DriveFile,
  DriveOpen,
  FolderLink,
  GoogleAccount,
  GoogleDriveFile,
  GoogleFolder,
  GoogleOutsideFile,
  MailClassification,
  MailDraft,
  Mailbox,
  MailMessage,
  MailProposal,
  MeetingTranscript,
  CalendarEvent,
  CalendarSeries,
  CalendarSync,
  SavedFilter,
  StatusFamily,
  Task,
  WeeklyBrief,
} from "./types";
import { can, resetViewerGrants, viewerFor } from "./viewer";

// Il «server» finto: il simulatore (latenza, errori iniettati), lo stato
// mutabile — una copia del seed, che `resetApi` rifà — e i derivati che le
// letture (`api.ts`) e le scritture (`api-mutations.ts`) condividono.

// --- controllo del simulatore ---------------------------------------------

let latencyOverride: number | null = null;
let callCounter = 0;
let chunkCounter = 0;
export type ApiFnName =
  | "listDepartments"
  | "listPeople"
  | "listProjects"
  | "getProjectByCode"
  | "listPinnedProjectIds"
  | "setPinned"
  | "listWaitingOnMeProjectIds"
  | "listProjectStatuses"
  | "listMilestones"
  | "listTasks"
  | "getTaskByCode"
  | "listActivity"
  | "listDecisionRequests"
  | "listClaudeDecisions"
  | "listRequests"
  | "listRequestsToConvert"
  | "getRequest"
  | "getRequestByCode"
  | "listDocPages"
  | "listSavedFilters"
  | "getSavedFilter"
  | "listPinnedFilterIds"
  | "listDepartmentHomes"
  | "getPersonalHome"
  | "listDepartmentRoles"
  | "listDayArrangements"
  | "listStalled"
  | "projectPulse"
  | "listProjectPulses"
  | "listPortfolioActivity"
  | "listTimeline"
  | "listDecisionLog"
  | "getLatestBrief"
  | "listNotifications"
  | "markNotification"
  | "search"
  | "createTask"
  | "updateTask"
  | "bulkUpdateTasks"
  | "planTask"
  | "setDay"
  | "addComment"
  | "editComment"
  | "deleteComment"
  | "askDecision"
  | "answerDecision"
  | "withdrawDecision"
  | "createRequest"
  | "updateRequest"
  | "mergeRequest"
  | "archiveRequest"
  | "reopenRequest"
  | "restoreRequest"
  | "startRefine"
  | "convertRequest"
  | "saveFilter"
  | "updateFilter"
  | "deleteFilter"
  | "setFilterPinned"
  | "setPersonalHome"
  | "resetPersonalHome"
  | "setDepartmentHome"
  | "markDepartmentHomeSeen"
  | "createProject"
  | "setProjectStatuses"
  | "setStallThresholds"
  | "recordDecision"
  | "setDecisionSuperseded"
  | "createMilestone"
  | "updateMilestone"
  | "deleteMilestone"
  | "listConversations"
  | "getConversation"
  | "getRefineOf"
  | "getTaskWork"
  | "listCommands"
  | "listPeopleActivity"
  | "listDailyReports"
  | "generateDailyReport"
  | "linkCommitAuthor"
  | "createConversation"
  | "sendMessage"
  | "stop"
  | "stopAndSend"
  | "answerQuestion"
  | "decidePlan"
  | "preApprovePlan"
  | "revokePlanApproval"
  | "confirmProposal"
  | "cancelProposal"
  | "editProposal"
  | "setVisibility"
  | "continueConversation"
  | "renameConversation"
  | "archiveConversation"
  | "deleteConversation"
  | "startRun"
  | "relaunchWithInstructions"
  | "resumeCorrection"
  | "requestChanges"
  | "startRefineConversation"
  | "closeRefine"
  | "resolveCitations"
  | "searchMentions"
  | "setConversationContext"
  | "completeEditedProposal"
  // Chat (area 4)
  | "chat.listChannels"
  | "chat.getChannel"
  | "chat.listChannelMembers"
  | "chat.listMessages"
  | "chat.getMessage"
  | "chat.listThread"
  | "chat.listThreadsWithNews"
  | "chat.listMentions"
  | "chat.listQuestions"
  | "chat.hasNews"
  | "chat.search"
  | "chat.sendMessage"
  | "chat.editMessage"
  | "chat.deleteMessage"
  | "chat.toggleReaction"
  | "chat.markRead"
  | "chat.markThreadRead"
  | "chat.setThreadFollow"
  | "chat.setNotifyLevel"
  | "chat.joinChannel"
  | "chat.leaveChannel"
  | "chat.createChannel"
  | "chat.updateChannel"
  | "chat.setPublishedEvents"
  | "chat.archiveChannel"
  | "chat.deleteChannel"
  | "chat.inviteMembers"
  | "chat.removeMember"
  | "chat.openDm"
  | "chat.createTaskFromMessage"
  | "chat.createRequestFromMessage"
  | "chat.dismissQuestion"
  | "chat.claudeReply"
  | "chat.stopClaudeReply"
  | "chat.retryClaudeReply"
  | "chat.confirmProposal"
  | "chat.cancelProposal"
  | "chat.editProposal"
  | "chat.completeEditedProposal"
  | "chat.answerClaudeQuestion"
  | "chat.listClaudeQuestions"
  // Docs (area 5)
  | "docs.listDocSpaces"
  | "docs.getDocSpace"
  | "docs.listDocTree"
  | "docs.getDocPage"
  | "docs.getProjectDocsHome"
  | "docs.searchDocs"
  | "docs.createManualPage"
  | "docs.updateManualPage"
  | "docs.deleteManualPage"
  | "docs.startGeneration"
  | "docs.resumeGeneration"
  | "docs.graphAction"
  | "docs.recordDocView"
  | "docs.getRepoBrief"
  | "docs.askDocs"
  /** Un passo della generazione simulata (in coda → in corso → riuscita). */
  | "docs.advanceGeneration"
  /** Un passo della costruzione simulata del grafo. */
  | "docs.advanceGraph"
  // Drive (area 5)
  | "drive.listDriveFiles"
  | "drive.getDriveFile"
  /** I file che Claude legge per chi chiede (non contano aperture). */
  | "drive.listForClaude"
  | "drive.listFolderLinks"
  | "drive.listMyFolderLinks"
  | "drive.countDriveReaders"
  | "drive.getGoogleAccount"
  | "drive.listGoogleOutside"
  | "drive.searchDrive"
  | "drive.listGoogleFolders"
  | "drive.listGoogleFiles"
  | "drive.uploadFiles"
  | "drive.deleteDriveFile"
  | "drive.removeGoogleFile"
  | "drive.setHidden"
  | "drive.linkFolder"
  | "drive.unlinkFolder"
  | "drive.addGoogleFile"
  | "drive.recordOpen"
  | "drive.retryExtraction"
  | "drive.connectGoogle"
  | "drive.disconnectGoogle"
  | "drive.syncFolder"
  /** Un passo dell'estrazione simulata del contenuto (in elaborazione → stato finale). */
  | "drive.advanceContent"
  // Posta (area 6)
  | "mail.listMailThreads"
  | "mail.getMailThread"
  | "mail.threadOfMessage"
  | "mail.listMailboxes"
  | "mail.listImportantMail"
  | "mail.searchMail"
  | "mail.markRead"
  | "mail.markUnread"
  | "mail.syncMailbox"
  | "mail.setProposalsEnabled"
  | "mail.reproposeMessage"
  | "mail.listMailProposals"
  | "mail.getMailProposal"
  | "mail.listMailDecisions"
  | "mail.confirmProposal"
  | "mail.ignoreProposal"
  | "mail.handProposal"
  | "mail.chooseProject"
  | "mail.reassignProposal"
  | "mail.getDraft"
  | "mail.listDrafts"
  | "mail.saveDraft"
  | "mail.discardDraft"
  | "mail.attachDriveFile"
  | "mail.sendDraft"
  | "mail.undoSend"
  | "mail.retrySend"
  | "mail.deleteFailedSend"
  | "mail.restoreDiscardedDraft"
  | "mail.suggestRecipients"
  | "mail.draftReply"
  | "mail.getMeetingSummary"
  | "mail.tasksBornFrom"
  /** Un passo dell'allineamento simulato di una casella (arriva la posta nuova). */
  | "mail.advanceSync"
  /** Un passo della classificazione simulata (in analisi → classificata o fallita). */
  | "mail.advanceClassification"
  // Calendario (area 6)
  | "calendar.listEvents"
  | "calendar.getEvent"
  | "calendar.listSeries"
  | "calendar.listCalendars"
  | "calendar.freeBusy"
  | "calendar.findFirstFreeSlot"
  | "calendar.listUpcomingEvents"
  | "calendar.getMeetingPrep"
  | "calendar.createEvent"
  | "calendar.updateEvent"
  | "calendar.moveEvent"
  | "calendar.deleteEvent"
  | "calendar.respond"
  | "calendar.retrySave"
  | "calendar.revertEvent"
  | "calendar.setEventProject"
  | "calendar.configureSeries"
  | "calendar.syncCalendar"
  /** Un passo del salvataggio simulato verso Google (in salvataggio → salvato o fallito). */
  | "calendar.advanceSave"
  /** Un passo dell'allineamento simulato di un calendario. */
  | "calendar.advanceSync"
  /** La risposta del cliente simulata in una conversazione della Posta (area 7). */
  | "mail.simulateReply"
  // Automations (area 7)
  | "automations.listAutomations"
  | "automations.getAutomation"
  | "automations.listRuns"
  | "automations.getRun"
  | "automations.listSources"
  | "automations.listClientLinks"
  | "automations.listMyApprovals"
  | "automations.searchAutomations"
  | "automations.createAutomation"
  | "automations.saveDraft"
  | "automations.publish"
  | "automations.activate"
  | "automations.pause"
  | "automations.deleteDraft"
  | "automations.startManual"
  | "automations.simulateSourceEvent"
  | "automations.runDueSchedules"
  | "automations.approve"
  | "automations.reject"
  | "automations.chooseProject"
  | "automations.cancelRun"
  | "automations.retryStep"
  | "automations.skipStep"
  | "automations.advanceTime"
  | "automations.connectSource"
  | "automations.disconnectSource"
  | "automations.setClientLink"
  | "automations.duplicateAutomation"
  | "automations.createWebhookSource"
  | "automations.renameSource"
  | "automations.regenerateWebhookAddress"
  | "automations.previewWebhookExample"
  | "automations.setWebhookExample"
  | "automations.updateWebhookField"
  | "automations.listClientSuggestions"
  | "automations.removeClientLink"
  // La prova (simulazione): in memoria, mai nello store.
  | "automations.startSimulation"
  | "automations.simulationStep"
  | "automations.getSimulation"
  | "automations.endSimulation"
  | "automations.listSimulationExamples"
  /** Un passo simulato di un'esecuzione: l'effetto (o la risposta di Claude) che arriva. */
  | "automations.advanceRun";
const failures = new Set<ApiFnName>();

/** Fissa la latenza simulata (ms); `0` per i test, `null` per tornare a 150–400 ms. */
export function setLatency(ms: number | null): void {
  latencyOverride = ms;
}

let streamLatencyOverride: number | null = null;

/**
 * Fissa solo l'attesa fra due pezzi dello stream (ms), diversa da quella
 * delle chiamate: per i test che riproducono uno stream più veloce delle
 * letture, come nell'app. `null` torna a seguire `setLatency`.
 */
export function setStreamLatency(ms: number | null): void {
  streamLatencyOverride = ms;
}

/**
 * L'attesa fra due pezzi dello stream di una conversazione (ms): quella
 * fissata con `setStreamLatency` o `setLatency`, altrimenti 40–160 ms
 * deterministici.
 */
export function streamDelay(): number {
  return streamLatencyOverride ?? latencyOverride ?? 40 + ((chunkCounter++ * 53) % 121);
}

/** Quanto resta «Riconnessione…» dopo una disconnessione (ms): la latenza fissata, altrimenti 800 ms. */
export function reconnectDelay(): number {
  return latencyOverride ?? 800;
}

/** La prossima chiamata a `fnName` (e solo quella) viene rifiutata. */
export function failNext(fnName: ApiFnName): void {
  failures.add(fnName);
}

/**
 * Attende la latenza simulata e restituisce chi sta guardando. La persona si
 * legge PRIMA dell'attesa: una chiamata partita a nome di una persona
 * risponde per lei anche se nel frattempo si è cambiato «vedi come».
 */
export async function gate(fnName: ApiFnName): Promise<string> {
  const me = getSessionPersonId();
  // Latenza deterministica (150–400 ms) che varia da una chiamata all'altra.
  const ms = latencyOverride ?? 150 + ((callCounter++ * 97) % 251);
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  if (failures.delete(fnName)) throw new Error(`Simulated failure: ${fnName}`);
  // Stato fresco: la prima chiamata porta le task scadute alla settimana corrente.
  if (!state.slipped) slipWeeks();
  return me;
}

// --- stato ------------------------------------------------------------------

export const copy = <T extends object>(x: T): T => structuredClone(x);

function initialPinned(): Map<string, string[]> {
  return new Map(
    Object.entries(INITIAL_PINNED_CODES).map(([personId, codes]) => [
      personId,
      codes.map((c) => PROJECTS.find((p) => p.code === c)!.id),
    ]),
  );
}

interface State {
  projects: Project[];
  statuses: ProjectStatus[];
  tasks: Task[];
  activity: ActivityEntry[];
  decisions: DecisionRequest[];
  requests: ProjectRequest[];
  milestones: Milestone[];
  briefs: WeeklyBrief[];
  decisionLog: DecisionLogEntry[];
  dailyReports: DailyReport[];
  /** Autori git dei commit collegati a una persona dopo il seed (nome git → id persona). */
  commitAuthorLinks: Map<string, string>;
  pullRequests: PullRequestEvent[];
  /** I fatti esterni delle PR (review, branch protetto, coda): il ciclo si deriva dalle sessioni. */
  prFacts: PrFact[];
  filters: SavedFilter[];
  departmentHomes: DepartmentHome[];
  personalHomes: PersonalHome[];
  arrangements: DayArrangement[];
  notifications: AppNotification[];
  conversations: Conversation[];
  /** Il flusso di ogni conversazione, per id: lo scrive solo il motore dello stream. */
  conversationEvents: Map<string, ConversationEvent[]>;
  /** Le sessioni di task il cui piano è approvato in anticipo (prima che arrivi): da chi. */
  preApprovedPlans: Map<string, string>;
  /**
   * Le conversazioni con un invio in corso (quanti): una libera ancora senza
   * messaggi resta fra le proprie solo finché il primo invio è in viaggio.
   */
  sendingTo: Map<string, number>;
  pinned: Map<string, string[]>;
  /** Filtri fissati, per persona. */
  pinnedFilters: Map<string, string[]>;
  projectsById: Map<string, Project>;
  statusById: Map<string, ProjectStatus>;
  tasksById: Map<string, Task>;
  /** Per gli id delle righe create. */
  counter: number;
  slipped: boolean;
  // --- Chat (area 4) ---
  channels: Channel[];
  /** Tutti i messaggi, radici e risposte, nell'ordine in cui sono arrivati. */
  chatMessages: ChatMessage[];
  /** Fin dove ognuno ha letto, per `chatKey(persona, canale)`. */
  chatReads: Map<string, ReadState>;
  /** Le preferenze di notifica diverse da «tutti», per `chatKey(persona, canale)`. */
  chatNotify: Map<string, NotifyLevel>;
  /** Le domande della Chat che una persona ha ignorato: `chatKey(persona, messaggio)`. */
  chatDismissed: Set<string>;
  /** Le pagine di Release (finte fino all'area 8). */
  releasePages: ReleasePage[];
  /** I secondi dopo «adesso» dati all'ultimo messaggio nuovo (`chatNow`). */
  chatSeq: number;
  // --- Docs (area 5) ---
  docPages: DocPage[];
  docSpaces: DocSpace[];
  /** L'ultimo numero di codice `<PRJ>-D<n>` dato, per progetto: un codice non si riusa. */
  docCodeSeq: Map<string, number>;
  /** Gli stati attraversati dall'ultimo avvio di una generazione, per repository. */
  docGenerationLog: Map<string, DocGeneration["status"][]>;
  /**
   * Il provider con chiave API che risponde nelle chat dei Docs (solo il
   * nome); `null` = nessuno, e la chat dice che non è disponibile.
   */
  docsChatProvider: string | null;
  // --- Drive (area 5) ---
  driveFiles: DriveFile[];
  /** Le aperture contate, in ordine di tempo. */
  driveOpens: DriveOpen[];
  /** Gli account Google personali; senza riga = non collegato. */
  googleAccounts: GoogleAccount[];
  folderLinks: FolderLink[];
  /** I file Google in nessun progetto (simulati: li vede chi ha l'account). */
  googleOutside: GoogleOutsideFile[];
  /** L'ultimo numero di codice `<PRJ>-F<n>` dato, per progetto: un codice non si riusa. */
  driveCodeSeq: Map<string, number>;
  /** Chi ha nascosto un file e quando, per id del file (solo i nascosti). */
  driveHidden: Map<string, { personId: string; at: string }>;
  /** Il lato Google (simulato): le cartelle e i file come li vede Google. */
  googleFolders: GoogleFolder[];
  googleFiles: GoogleDriveFile[];
  /** Gli stati del contenuto attraversati da un file dopo il seme (per i test e i passi simulati). */
  driveContentLog: Map<string, ContentState[]>;
  /** I file che il seme lascia in elaborazione sono già partiti (alla prima lettura del Drive). */
  driveSeedWorkStarted: boolean;
  // --- Posta (area 6) ---
  /** Le caselle Gmail, una per account Google. */
  mailboxes: Mailbox[];
  /** Tutti i messaggi, una riga per Message-ID anche se è in più caselle. */
  mailMessages: MailMessage[];
  /** Le note delle riunioni registrate, per id del messaggio di Gemini. */
  meetingTranscripts: MeetingTranscript[];
  /** Le proposte della posta, condivise fra i destinatari membri del progetto. */
  mailProposals: MailProposal[];
  /** Le bozze, per persona e conversazione. */
  mailDrafts: MailDraft[];
  /** La posta non ancora arrivata: la porta dentro l'allineamento della sua casella. */
  mailIncoming: MailMessage[];
  /** Gli stati di classificazione attraversati da un messaggio dopo il seme (per i test). */
  mailClassificationLog: Map<string, MailClassification["state"][]>;
  // --- Calendario (area 6) ---
  /** Gli eventi come li ha Google, una riga per occorrenza (anche fuori dalla finestra letta). */
  calendarEvents: CalendarEvent[];
  calendarSeries: CalendarSeries[];
  /** L'allineamento del calendario di ogni persona con l'account Google. */
  calendarSync: CalendarSync[];
  /** Gli eventi del seme che falliscono al primo salvataggio e lo hanno già fatto. */
  calendarFailedOnce: Set<string>;
  // --- Automations (area 7) ---
  automations: Automation[];
  /** Le esecuzioni delle automazioni (non quelle di Claude: `conversations`). */
  automationRuns: AutomationRun[];
  automationSources: AutomationSource[];
  /** La tabella cliente → progetto delle automazioni generali. */
  clientProjectLinks: ClientProjectLink[];
  /** L'ultimo numero di codice dato, per progetto (`""` = generali): un codice non si riusa. */
  automationCodeSeq: Map<string, number>;
  /** L'«adesso» di un'esecuzione mandata avanti con «Fai passare il tempo» (solo prototipo). */
  automationClock: Map<string, string>;
}

function initialAutomationCodeSeq(): Map<string, number> {
  const seq = new Map<string, number>();
  for (const a of AUTOMATIONS) {
    const key = a.projectId ?? "";
    const n = Number(a.code.slice(a.code.search(/\d+$/)));
    seq.set(key, Math.max(seq.get(key) ?? 0, n));
  }
  return seq;
}

function initialDocCodeSeq(): Map<string, number> {
  const seq = new Map<string, number>();
  for (const page of DOC_PAGES) {
    const n = Number(page.code.slice(page.code.lastIndexOf("-D") + 2));
    seq.set(page.projectId, Math.max(seq.get(page.projectId) ?? 0, n));
  }
  return seq;
}

function initialDriveCodeSeq(): Map<string, number> {
  const seq = new Map<string, number>();
  for (const file of DRIVE_FILES) {
    const n = Number(file.code.slice(file.code.lastIndexOf("-F") + 2));
    seq.set(file.projectId, Math.max(seq.get(file.projectId) ?? 0, n));
  }
  return seq;
}

/** La chiave di una coppia (persona, canale o messaggio) nelle mappe della Chat. */
export const chatKey = (personId: string, id: string): string => `${personId}\u0000${id}`;

function freshState(): State {
  return {
    projects: PROJECTS.map(copy),
    statuses: PROJECT_STATUSES.map(copy),
    tasks: TASKS.map(copy),
    activity: ACTIVITY.map(copy),
    decisions: DECISION_REQUESTS.map(copy),
    requests: REQUESTS.map(copy),
    milestones: MILESTONES.map(copy),
    briefs: BRIEFS.map(copy),
    decisionLog: DECISION_LOG.map(copy),
    dailyReports: DAILY_REPORTS.map(copy),
    commitAuthorLinks: new Map(),
    pullRequests: PULL_REQUEST_EVENTS.map(copy),
    prFacts: PR_FACTS.map(copy),
    filters: SAVED_FILTERS.map(copy),
    departmentHomes: DEPARTMENT_HOMES.map(copy),
    personalHomes: PERSONAL_HOMES.map(copy),
    arrangements: DAY_ARRANGEMENTS.map(copy),
    notifications: [...NOTIFICATIONS, ...CHAT_NOTIFICATIONS].map(copy),
    conversations: CONVERSATIONS.map(copy),
    conversationEvents: new Map(
      Object.entries(CONVERSATION_EVENTS).map(([id, events]) => [id, events.map(copy)]),
    ),
    preApprovedPlans: new Map(),
    sendingTo: new Map(),
    pinned: initialPinned(),
    pinnedFilters: new Map(Object.entries(INITIAL_PINNED_FILTERS).map(([k, v]) => [k, [...v]])),
    projectsById: new Map(),
    statusById: new Map(),
    tasksById: new Map(),
    counter: 0,
    slipped: false,
    channels: CHAT_CHANNELS.map(copy),
    chatMessages: CHAT_MESSAGES.map(copy),
    chatReads: new Map(CHAT_READ_STATES.map((r) => [chatKey(r.personId, r.channelId), copy(r)])),
    chatNotify: new Map(CHAT_NOTIFY_PREFS.map((p) => [chatKey(p.personId, p.channelId), p.level])),
    chatDismissed: new Set(),
    releasePages: RELEASE_PAGES.map(copy),
    chatSeq: 0,
    docPages: DOC_PAGES.map(copy),
    docSpaces: DOC_SPACES.map(copy),
    docCodeSeq: initialDocCodeSeq(),
    docGenerationLog: new Map(),
    docsChatProvider: "Team API key",
    driveFiles: DRIVE_FILES.map(copy),
    driveOpens: DRIVE_OPENS.map(copy),
    googleAccounts: GOOGLE_ACCOUNTS.map(copy),
    folderLinks: FOLDER_LINKS.map(copy),
    googleOutside: GOOGLE_OUTSIDE_FILES.map(copy),
    driveCodeSeq: initialDriveCodeSeq(),
    driveHidden: new Map(DRIVE_HIDDEN.map((h) => [h.fileId, { personId: h.personId, at: h.at }])),
    googleFolders: GOOGLE_FOLDERS.map(copy),
    googleFiles: GOOGLE_DRIVE_FILES.map(copy),
    driveContentLog: new Map(),
    driveSeedWorkStarted: false,
    mailboxes: MAILBOXES.map(copy),
    mailMessages: MAIL_MESSAGES.map(copy),
    meetingTranscripts: MEETING_TRANSCRIPTS.map(copy),
    mailProposals: [...MAIL_PROPOSALS, ...CALENDAR_PROPOSALS].map(copy),
    mailDrafts: MAIL_DRAFTS.map(copy),
    mailIncoming: MAIL_INCOMING.map(copy),
    mailClassificationLog: new Map(),
    calendarEvents: CALENDAR_EVENTS.map(copy),
    calendarSeries: CALENDAR_SERIES.map(copy),
    calendarSync: CALENDAR_SYNC.map(copy),
    calendarFailedOnce: new Set(),
    automations: AUTOMATIONS.map(copy),
    automationRuns: AUTOMATION_RUNS.map(copy),
    automationSources: AUTOMATION_SOURCES.map(copy),
    clientProjectLinks: CLIENT_PROJECT_LINKS.map(copy),
    automationCodeSeq: initialAutomationCodeSeq(),
    automationClock: new Map(),
  };
}

export const state: State = freshState();

/** Rifà le mappe per id dopo che un array è cambiato di struttura. */
export function reindex(): void {
  state.projectsById = new Map(state.projects.map((p) => [p.id, p]));
  state.statusById = new Map(state.statuses.map((s) => [s.id, s]));
  state.tasksById = new Map(state.tasks.map((t) => [t.id, t]));
}
reindex();

const resetHooks = new Set<() => void>();

/** Cambia a ogni ripristino: il lavoro partito prima sa che lo stato non è più il suo. */
let generation = 0;

/**
 * La generazione dello stato di adesso. Chi la fissa all'inizio di una
 * scrittura sa se nel frattempo c'è stato un ripristino, e smette di
 * scrivere (nei test: mai nello stato del test dopo).
 */
export const storeGeneration = (): number => generation;

/**
 * Lavoro da fermare quando lo stato si ripristina (es. gli stream in corso,
 * che altrimenti continuerebbero a scrivere nello stato nuovo).
 */
export function onStoreReset(fn: () => void): void {
  resetHooks.add(fn);
}

/** Ripristina lo stato (sessione, dati, errori iniettati). */
export function resetStore(): void {
  generation += 1;
  for (const fn of resetHooks) fn();
  failures.clear();
  streamLatencyOverride = null;
  callCounter = 0;
  chunkCounter = 0;
  setSessionPersonId(DEFAULT_SESSION_PERSON_ID);
  resetViewerGrants();
  Object.assign(state, freshState());
  reindex();
}

// --- i segnali per gli inizi delle automazioni (area 7) -----------------------

/**
 * Qualcosa è successo in Stubwise: lo segnalano le scritture di oggi (task
 * creata o chiusa, richiesta creata, traguardo raggiunto, posta arrivata) e
 * lo ascoltano gli inizi `stubwise` delle automazioni. Un ascoltatore non
 * scrive nulla mentre la scrittura è in corso: mette in coda.
 */
export type AutomationSignal =
  | { kind: "task_created" | "task_closed"; taskId: string }
  | { kind: "request_created"; requestId: string }
  | { kind: "milestone_reached"; milestoneId: string }
  | { kind: "mail_received"; messageIds: string[] };

const automationListeners = new Set<(signal: AutomationSignal) => void>();

/** Ascolta i segnali; restituisce come smettere. */
export function onAutomationSignal(fn: (signal: AutomationSignal) => void): () => void {
  automationListeners.add(fn);
  return () => automationListeners.delete(fn);
}

export function signalAutomations(signal: AutomationSignal): void {
  for (const fn of automationListeners) fn(signal);
}

/** L'id di una riga creata dal prototipo. */
export const newId = (prefix: string): string => `${prefix}-new-${++state.counter}`;

/** L'«adesso» del prototipo: nessuna logica legge l'orologio. */
export const now = (): string => `${TODAY}T12:00:00Z`;

/**
 * L'ora di un messaggio nuovo della Chat: «adesso» più un secondo per ogni
 * messaggio già scritto, così l'ordine e i non letti restano veri anche con
 * l'orologio fisso (due messaggi alla stessa ora non si distinguerebbero).
 * Stesso formato del seed (`…T12:00:05Z`), che si confronta come stringa.
 */
export function chatNow(): string {
  const at = new Date(Date.parse(now()) + ++state.chatSeq * 1000);
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const familyOf = (task: Task): StatusFamily => state.statusById.get(task.statusId)!.family;

/**
 * Le task aperte pianificate in una settimana passata scivolano alla corrente,
 * con `slipCount + 1`. Idempotente: dopo il primo giro nessuna è più nel passato.
 */
export function slipWeeks(): void {
  const week = currentWeek();
  for (const task of state.tasks) {
    if (task.plannedWeek && task.plannedWeek < week && familyOf(task) !== "closed") {
      task.plannedWeek = week;
      task.slipCount += 1;
    }
  }
  state.slipped = true;
}

// --- visibilità e derivati (come sul server) --------------------------------

/** I progetti che una persona vede: quelli di cui è membro, o tutti se è full admin. */
export function visibleProjectIds(personId: string): Set<string> {
  const viewer = viewerFor(personId);
  if (viewer.instancePermissions.includes("instance.full_admin")) {
    return new Set(state.projects.map((p) => p.id));
  }
  return new Set(state.projects.filter((p) => p.memberIds.includes(personId)).map((p) => p.id));
}

/**
 * Chi vede una conversazione con Claude — l'unica regola, per le letture e
 * per lo stream. Libera privata: chi l'ha aperta; pubblica: anche chi ha
 * `claude.public.view`. Sessioni di lavoro: `repos.view` nel progetto (il
 * refine `backlog.edit`). Posta: solo il titolare, mai gli admin.
 */
export function canSeeConversation(personId: string, c: Conversation): boolean {
  const viewer = viewerFor(personId);
  switch (c.kind) {
    case "free":
      return (
        c.ownerId === personId || (c.visibility === "public" && can(viewer, "claude.public.view"))
      );
    case "mail_classify":
      return c.ownerId === personId;
    case "refine":
      return c.projectId !== null && can(viewer, "backlog.edit", c.projectId);
    default:
      return c.projectId !== null && can(viewer, "repos.view", c.projectId);
  }
}

/**
 * Una proposta aperta scade dopo 20 messaggi successivi — di chi scrive e di
 * Claude: azioni, fasi e risultati non contano — o dopo 24 ore (spec §2).
 */
export const PROPOSAL_EXPIRY = { messages: 20, ms: 24 * 60 * 60 * 1000 } as const;

/** Un messaggio della conversazione: quello che conta per la scadenza di una proposta. */
export const isMessage = (e: ConversationEvent): boolean =>
  e.type === "user" || e.type === "assistant";

/** Quanti messaggi seguono nel flusso l'evento in posizione `index`. */
export function messagesAfter(log: readonly ConversationEvent[], index: number): number {
  let count = 0;
  for (let i = index + 1; i < log.length; i++) if (isMessage(log[i]!)) count++;
  return count;
}

/**
 * Vero se la proposta in posizione `index` del flusso è scaduta adesso: si
 * calcola a lettura (orologio fisso del prototipo), non si salva.
 */
export function proposalExpired(log: readonly ConversationEvent[], index: number): boolean {
  const event = log[index];
  if (!event || event.type !== "proposal" || event.status !== "open") return false;
  return (
    messagesAfter(log, index) >= PROPOSAL_EXPIRY.messages ||
    Date.parse(now()) - Date.parse(event.at) >= PROPOSAL_EXPIRY.ms
  );
}

/**
 * Un evento del flusso come lo legge chi guarda: una copia, con la proposta
 * scaduta già detta `expired`. Lo usano lo stream e le letture.
 */
export function presentEvent(log: readonly ConversationEvent[], index: number): ConversationEvent {
  const event = copy(log[index]!);
  if (event.type === "proposal" && proposalExpired(log, index)) event.status = "expired";
  return event;
}

/**
 * Lo stato di Claude sulla task segue la sua sessione di lavoro (come
 * `task.claude` del seed): al lavoro, aspetta, fermata, fatta.
 */
export function syncTaskClaude(c: Conversation): void {
  if (c.kind !== "task_run" || c.taskId === null) return;
  const task = state.tasksById.get(c.taskId);
  if (!task) return;
  switch (c.state) {
    case "finished":
      task.claude = c.outcome === "ok" ? "done" : "stopped";
      break;
    case "paused":
      task.claude = "stopped";
      break;
    case "working":
    case "awaiting_answer":
    case "awaiting_approval":
      task.claude = c.state;
      break;
    case "idle":
      break;
  }
}

/** Le sessioni automatiche: si guardano, non si scrivono (come oggi). */
const AUTOMATIC_KINDS: ReadonlySet<ConversationKind> = new Set([
  "pr_review",
  "docs",
  "brief",
  "daily_report",
  "mail_classify",
  "intake",
]);

export const eventsOf = (conversationId: string): ConversationEvent[] =>
  state.conversationEvents.get(conversationId) ?? [];

/** L'ultimo evento che soddisfa `test`, dal fondo del flusso. */
export function lastEvent<E extends ConversationEvent>(
  log: readonly ConversationEvent[],
  test: (e: ConversationEvent) => e is E,
): E | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (test(e)) return e;
  }
  return undefined;
}

type QuestionEvent = Extract<ConversationEvent, { type: "question" }>;
type PlanEvent = Extract<ConversationEvent, { type: "plan" }>;

/** La domanda ancora senza risposta (al più una per volta). */
export const openQuestion = (log: readonly ConversationEvent[]) =>
  lastEvent(log, (e): e is QuestionEvent => e.type === "question" && e.answer === null);

/** Il piano che aspetta una decisione. */
export const pendingPlan = (log: readonly ConversationEvent[]) =>
  lastEvent(log, (e): e is PlanEvent => e.type === "plan" && e.status === "pending");

/** La fase in cui si trova una sessione: l'ultima del flusso. */
export function currentPhase(log: readonly ConversationEvent[]): string | null {
  const phase = lastEvent(
    log,
    (e): e is Extract<ConversationEvent, { type: "phase" }> => e.type === "phase",
  );
  return phase?.phase ?? null;
}

/**
 * Cosa può fare una persona in una conversazione che vede: la regola del
 * server di oggi (`canWrite`/`canInterrupt`/`canAnswer`, gate del piano),
 * in un posto solo. Scrivere in una sessione di task chiede
 * `agent_sessions.intervene` e un passo interattivo (al lavoro o in pausa);
 * nel refine `backlog.edit` finché la sessione è aperta. Rispondere: il
 * richiedente o chi ha `plans.approve`. Una libera la scrive solo l'autore.
 */
export function conversationPermissions(
  personId: string,
  c: Conversation,
): ConversationPermissions {
  const viewer = viewerFor(personId);
  const log = eventsOf(c.id);
  const isOwner = c.ownerId === personId;
  const inProject = (perm: Parameters<typeof can>[1]) =>
    c.projectId !== null && can(viewer, perm, c.projectId);
  const approver = c.kind === "task_run" && inProject("plans.approve");
  const live = c.state !== "finished";
  const planning = currentPhase(log) === "plan" && !log.some((e) => e.type === "plan");

  let canWrite = false;
  let canInterrupt = false;
  let readOnlyReason: ReadOnlyReason | null = null;
  if (c.kind === "free") {
    canWrite = isOwner && !c.archived;
    // L'autore ferma la risposta in corso (e quelle in coda dietro di lei).
    canInterrupt = canWrite && c.state === "working";
    if (!canWrite) readOnlyReason = isOwner ? "archived" : "not_owner";
  } else if (AUTOMATIC_KINDS.has(c.kind)) {
    readOnlyReason = "automatic";
  } else if (!live) {
    readOnlyReason = "finished";
  } else {
    const allowed = inProject(c.kind === "refine" ? "backlog.edit" : "agent_sessions.intervene");
    const interactive = c.kind === "refine" ? true : c.state === "working" || c.state === "paused";
    canWrite = allowed && interactive;
    canInterrupt = allowed && c.state === "working";
    if (!canWrite) readOnlyReason = allowed ? "not_interactive" : "no_permission";
  }

  const question = openQuestion(log);
  const plan = pendingPlan(log);
  const preApproved = state.preApprovedPlans.has(c.id);
  // Il refine: lo chiude e ne avvia uno nuovo chi ha `backlog.edit`; uno
  // nuovo solo se la richiesta si può ancora rifinire (`startRefineConversation`).
  const refiner = c.kind === "refine" && inProject("backlog.edit");
  const request =
    c.kind === "refine" ? state.requests.find((r) => r.id === c.requestId) : undefined;
  const refinable =
    request !== undefined &&
    ["new", "ready", "refining"].includes(request.status) &&
    request.mergedIntoId === null;
  return {
    isOwner,
    canWrite,
    canInterrupt,
    canAnswer: question !== undefined && live && (isOwner || inProject("plans.approve")),
    canDecidePlan: plan !== undefined && approver && c.state === "awaiting_approval",
    canPreApprovePlan: approver && live && planning && !preApproved,
    // Revocabile solo finché il piano non è arrivato: dopo, l'anticipo è già speso.
    canRevokePlanApproval: approver && live && planning && preApproved,
    canContinue: c.kind === "free" && !isOwner && c.visibility === "public",
    canManage: c.kind === "free" && isOwner,
    canClose: refiner && live,
    canStartNew: refiner && !live && refinable,
    readOnlyReason,
  };
}

/** Il codice dell'oggetto della sessione (task o richiesta), se c'è. */
export function objectCodeOf(c: Conversation): string | null {
  if (c.taskId) return state.tasksById.get(c.taskId)?.code ?? null;
  if (c.requestId) return state.requests.find((r) => r.id === c.requestId)?.code ?? null;
  return null;
}

/** Cosa sta facendo Claude adesso: l'azione in corso, una domanda o un piano che aspettano. */
export function activityOf(c: Conversation): ConversationActivity {
  if (c.state === "awaiting_answer") return { kind: "question" };
  if (c.state === "awaiting_approval") return { kind: "plan" };
  if (c.state !== "working") return null;
  const running = lastEvent(
    eventsOf(c.id),
    (e): e is Extract<ConversationEvent, { type: "action" }> =>
      e.type === "action" && e.state === "running",
  );
  return running ? { kind: "action", label: running.label } : null;
}

/**
 * La conversazione come la legge una persona: una copia, e i progetti toccati
 * ridotti a quelli che vede (un progetto invisibile non si nomina, come un
 * oggetto che non esiste).
 */
export function conversationRow(personId: string, c: Conversation): ConversationRow {
  const visible = visibleProjectIds(personId);
  const row = copy(c);
  const privateTail = hasPrivateTail(personId, c);
  if (c.ownerId !== personId) {
    // Chi non è l'autore di una pubblica vede solo i progetti confermati
    // (R-E6): uno toccato dopo resta dell'autore finché non lo riconferma.
    const shown = c.visibility === "public" ? c.publishedProjectIds : c.touchedProjectIds;
    row.touchedProjectIds = shown.filter((id) => visible.has(id));
    row.publishedProjectIds = row.publishedProjectIds.filter((id) => visible.has(id));
    if (row.contextProjectId !== null && !visible.has(row.contextProjectId)) {
      row.contextProjectId = null;
    }
  }
  if (privateTail) {
    // Nemmeno il movimento del seguito privato si vede: la riga resta
    // com'era all'ultimo evento leggibile.
    const lastReadable = eventsOf(c.id)[c.privateFromIndex! - 1];
    row.state = "idle";
    row.outcome = null;
    row.updatedAt = lastReadable?.at ?? c.createdAt;
  }
  return {
    ...row,
    objectCode: objectCodeOf(c),
    // Cosa fa Claude nel seguito privato non si dice a chi non è l'autore.
    activity: privateTail ? null : activityOf(c),
    privateTail,
    waitsOnViewer: waitsOn(personId, c),
  };
}

/** Claude aspetta questa persona: una domanda a cui può rispondere o un piano che può decidere. */
function waitsOn(personId: string, c: Conversation): boolean {
  if (c.state !== "awaiting_answer" && c.state !== "awaiting_approval") return false;
  const perms = conversationPermissions(personId, c);
  return perms.canAnswer || perms.canDecidePlan;
}

/**
 * Le domande e i piani di Claude che aspettano una persona, dalle sole
 * conversazioni che vede: la domanda se può rispondere (richiedente o
 * `plans.approve`), il piano se può deciderlo (`plans.approve`). Solo eventi
 * che può leggere (mai dal seguito privato di una pubblica). Sono la stessa
 * domanda e lo stesso piano della conversazione: rispondere in un posto li
 * chiude nell'altro.
 */
export function waitingClaudeEvents(
  personId: string,
): { conversation: Conversation; event: QuestionEvent | PlanEvent }[] {
  const out: { conversation: Conversation; event: QuestionEvent | PlanEvent }[] = [];
  for (const c of state.conversations) {
    if (!canSeeConversation(personId, c) || !waitsOn(personId, c)) continue;
    const log = eventsOf(c.id);
    const readable = log.slice(0, readableLength(personId, c));
    const perms = conversationPermissions(personId, c);
    const question = perms.canAnswer ? openQuestion(readable) : undefined;
    const plan = perms.canDecidePlan ? pendingPlan(readable) : undefined;
    if (question) out.push({ conversation: c, event: question });
    if (plan) out.push({ conversation: c, event: plan });
  }
  return out;
}

/** Vero se per questa persona il seguito della pubblica è privato (R-E6). */
export function hasPrivateTail(personId: string, c: Conversation): boolean {
  return c.privateFromIndex !== null && c.ownerId !== personId;
}

/**
 * Quanti eventi del flusso una persona può leggere: tutti, salvo il seguito
 * privato di una pubblica per chi non è l'autore (R-E6).
 */
export function readableLength(personId: string, c: Conversation): number {
  const length = eventsOf(c.id).length;
  return hasPrivateTail(personId, c) ? Math.min(length, c.privateFromIndex!) : length;
}

/** Un progetto con un repository (template `software`): prova il codice e apre PR. */
export function hasRepository(projectId: string): boolean {
  return state.projectsById.get(projectId)?.template === "software";
}

/**
 * Le PR della task con il loro stato, PR per PR (`repo#numero`): la stessa
 * derivazione della sezione «Claude» (`prLines`), sui flussi di tutte le
 * sessioni di lavoro e sugli eventi della piattaforma. Solo un progetto con
 * un repository ha PR.
 */
function prLinesOf(task: Task): PrLine[] {
  if (!hasRepository(task.projectId)) return [];
  const events = state.conversations
    .filter((c) => c.kind === "task_run" && c.taskId === task.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .flatMap((c) => eventsOf(c.id));
  const platform = state.pullRequests
    .filter((pr) => pr.taskId === task.id)
    .sort((a, b) => a.at.localeCompare(b.at));
  return prLines(events, platform);
}

/** La task ha almeno una PR ancora aperta (una chiusura di un'altra PR non la chiude). */
export function hasOpenPr(task: Task): boolean {
  return prLinesOf(task).some((line) => line.state === "open");
}

/**
 * La PR aperta più recente della task (dalla pipeline o dalla piattaforma):
 * quella su cui «Request changes» apre la correzione. `null` se nessuna è
 * aperta o la PR aperta non dice numero e repository.
 */
export function latestOpenPrOf(task: Task): PrRef | null {
  const latest = prLinesOf(task)
    .filter((line) => line.state === "open" && line.number !== null && line.repo !== null)
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt))
    .at(-1);
  return latest ? { repo: latest.repo!, number: latest.number! } : null;
}

/** L'ultima sessione di lavoro della task (la più recente), visibile o no. */
export function latestRunOf(taskId: string): Conversation | undefined {
  return state.conversations
    .filter((c) => c.kind === "task_run" && c.taskId === taskId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
}

/** L'ultimo evento delle PR della task sulla piattaforma è un merge, e nessuna è aperta. */
export function lastPrMerged(task: Task): boolean {
  if (!hasRepository(task.projectId)) return false;
  const last = state.pullRequests
    .filter((pr) => pr.taskId === task.id)
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  return last?.kind === "pr_merged" && !hasOpenPr(task);
}

/**
 * Le precondizioni di stato delle azioni sul lavoro di Claude (i permessi
 * a parte): le stesse che controllano le scritture (`startRun`,
 * `relaunchWithInstructions`, `resumeCorrection`, `requestChanges`), in un
 * posto solo, così la sezione della task le legge invece di dedurle.
 * - avviare: task aperta, nessun lavoro vivo;
 * - rilanciare: task aperta, l'ultimo lavoro concluso o in pausa, la PR
 *   non è già mergiata;
 * - riprendere la correzione: l'ultimo lavoro è in pausa nella correzione;
 * - chiedere modifiche: una PR aperta e nessun lavoro vivo.
 */
export function runPreconditions(task: Task): {
  start: boolean;
  relaunch: boolean;
  resume: boolean;
  requestChanges: boolean;
} {
  const open = familyOf(task) !== "closed";
  const latest = latestRunOf(task.id);
  const live = latest !== undefined && latest.state !== "finished";
  const settled = !latest || latest.state === "finished" || latest.state === "paused";
  return {
    start: open && !live,
    relaunch: open && settled && !lastPrMerged(task),
    resume: latest?.state === "paused" && currentPhase(eventsOf(latest.id)) === "correction",
    requestChanges: hasOpenPr(task) && !live,
  };
}

export const openDecisions = () =>
  state.decisions.filter((d) => d.answer === null && d.withdrawnAt === null);

/**
 * Lo stato «ferma» come lo vede una persona: le bloccanti si cercano solo fra
 * le task che vede. Una bloccante invisibile non compare e non ferma la task
 * per lei (altrimenti la task direbbe «Blocked by unknown»). La mappa delle
 * visibili si costruisce una volta per chiamata, non per task.
 */
export function stallScope(
  personId: string,
  open: DecisionRequest[] = openDecisions(),
): (task: Task) => Stall | null {
  const visible = visibleProjectIds(personId);
  const tasksById = new Map(
    state.tasks.filter((t) => visible.has(t.projectId)).map((t) => [t.id, t]),
  );
  return (task) =>
    stallOf(task, {
      family: familyOf(task),
      openDecisions: open,
      tasksById,
      familyOf,
      thresholds: state.projectsById.get(task.projectId)!.stallThresholds,
    });
}

export function filterContext(personId: string): FilterContext {
  const stallOfTask = stallScope(personId);
  return {
    familyOf,
    isStalled: (task) => stallOfTask(task) !== null,
    projectName: (id) => state.projectsById.get(id)?.name ?? "",
  };
}

export function visibleTasks(personId: string): Task[] {
  const visible = visibleProjectIds(personId);
  return state.tasks.filter((t) => visible.has(t.projectId));
}

/**
 * Le task ferme che la persona vede (eventualmente filtrate), dalla più
 * vecchia: `listStalled` e la scheda di preparazione del Calendario.
 */
export function stalledTasks(
  personId: string,
  criteria?: FilterCriteria,
): { task: Task; stall: Stall }[] {
  const ctx = filterContext(personId);
  const stallOfTask = stallScope(personId);
  return visibleTasks(personId)
    .filter((t) => !criteria || matches(t, criteria, ctx))
    .flatMap((t) => {
      const stall = stallOfTask(t);
      return stall ? [{ task: copy(t), stall }] : [];
    })
    .sort((a, b) => b.stall.days - a.stall.days || a.task.code.localeCompare(b.task.code));
}

/**
 * Il polso di un progetto per una persona (che lo vede): `projectPulse`,
 * `listProjectPulses` e la scheda di preparazione del Calendario.
 */
export function pulseOf(
  personId: string,
  project: Project,
  open: DecisionRequest[] = openDecisions(),
): ProjectPulse {
  const projectId = project.id;
  const tasks = state.tasks.filter((t) => t.projectId === projectId);
  const stallOfTask = stallScope(personId, open);
  const nextMilestone =
    state.milestones
      .filter((m) => m.projectId === projectId && !m.closed && m.dueDate)
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
      .at(0) ?? null;
  return {
    projectId,
    open: {
      todo: tasks.filter((t) => familyOf(t) === "todo").length,
      active: tasks.filter((t) => familyOf(t) === "active").length,
    },
    stalled: tasks.filter((t) => stallOfTask(t) !== null).length,
    waitingOnMe: waitingOnMe(personId).has(projectId),
    claudeWorking: project.signals.claudeWorking,
    nextMilestone: nextMilestone ? copy(nextMilestone) : null,
  };
}

/**
 * Progetti dove la persona deve decidere qualcosa: decisioni aperte per lei,
 * domande e piani di Claude che aspettano lei, richieste nuove da trasformare.
 */
export function waitingOnMe(personId: string): Set<string> {
  const visible = visibleProjectIds(personId);
  const viewer = viewerFor(personId);
  const out = new Set<string>();
  for (const d of openDecisions()) {
    const projectId = state.tasksById.get(d.taskId)!.projectId;
    if (d.askedOfId === personId && visible.has(projectId)) out.add(projectId);
  }
  for (const { conversation } of waitingClaudeEvents(personId)) {
    if (conversation.projectId !== null && visible.has(conversation.projectId)) {
      out.add(conversation.projectId);
    }
  }
  for (const r of state.requests) {
    if (
      r.status === "new" &&
      visible.has(r.projectId) &&
      can(viewer, "tickets.create", r.projectId)
    )
      out.add(r.projectId);
  }
  return out;
}
