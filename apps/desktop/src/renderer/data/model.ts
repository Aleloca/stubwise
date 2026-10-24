import type { TicketPriority } from "@stubwise/shared";

// Modello dati dell'area 2 (task). Autonomo: il Task 2 farà di `types.ts` un
// re-export di questo file più i tipi dell'ossatura che restano.

export interface Department {
  id: string;
  name: string;
  colorToken: `--dept-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
}

export interface Person {
  id: string;
  name: string;
  initials: string;
  departmentIds: string[];
  isClaude: boolean;
  /** Chiave di un `PRESET_ROLES` di `@stubwise/shared` (ruolo tipico della persona). */
  presetRole: string;
}

export type ProjectModule = "docs" | "releases" | "support" | "servers";
export type ProjectTemplate = "software" | "marketing" | "client" | "empty";

export interface Project {
  id: string;
  /** 2–4 maiuscole, univoco. */
  code: string;
  name: string;
  kind: "internal" | "client";
  clientName?: string;
  template: ProjectTemplate;
  modules: ProjectModule[];
  memberIds: string[];
  /** Giorni senza attività dopo i quali una task è ferma (`active`; `todo` già slittata). */
  stallThresholds: { activeDays: number; todoDays: number };
  signals: { claudeWorking: boolean };
  /** Il tetto delle correzioni automatiche per PR (impostazione di progetto); assente = 3. */
  correctionCap?: number;
}

export interface AppNotification {
  id: string;
  /** Valori di `notificationKindSchema` (più i tipi locali del prototipo). */
  kind: string;
  projectId: string | null;
  /**
   * Codice dell'oggetto della notifica, che apre la riga: una task
   * (`MKX-2`), un progetto (`LMR`) o un evento (`MAIL-1`, `SEC-1`…).
   */
  objectCode: string;
  /** Reparto della task, se l'oggetto è una task; altrimenti `null`. */
  departmentId: string | null;
  recipientIds: string[];
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  archived: boolean;
  snoozedUntil: string | null;
  /** Route hash. */
  link: string;
  /**
   * Solo una menzione della Chat: il messaggio. Titolo e testo si derivano a
   * lettura dal messaggio di adesso (eliminato o non più leggibile: la
   * notifica non c'è più), mai salvati qui.
   */
  chatMessageId?: string;
}

export type StatusFamily = "todo" | "active" | "closed";

export interface ProjectStatus {
  id: string;
  projectId: string;
  name: string;
  family: StatusFamily;
  order: number;
}

export type TaskSize = "XS" | "S" | "M" | "L" | "XL";
export type TaskType = "bug" | "feature" | "activity";
export type TaskPriority = TicketPriority;
export type ClaudeWorkState =
  | "none"
  | "working"
  | "awaiting_answer"
  | "awaiting_approval"
  | "stopped"
  | "done";
/**
 * Un collegamento si salva UNA volta, come sul web (una riga di relazione):
 * sulla task che «blocca», che «è correlata» o che ha un «padre». Gli inversi
 * («bloccata da», «figlia», la correlazione vista dall'altra parte) si
 * ricavano in lettura (`domain/links.ts`): non si scrivono mai.
 */
export type StoredLinkKind = "blocks" | "relates" | "parent";
/** Come si vede un collegamento da una task: le righe sue più gli inversi ricavati. */
export type TaskLinkKind = StoredLinkKind | "blocked_by" | "child";

/**
 * Da dove è arrivata una task: a mano, da un'integrazione (SDK, API, Slack,
 * webhook, widget), dalla posta o da un'automazione. Al posto di `source` del
 * ticket del web (dove l'SDK distingue errore e feedback).
 */
export type TaskSource =
  | "manual"
  | "sdk"
  | "api"
  | "slack"
  | "webhook"
  | "widget"
  | "email"
  | "automation";

export interface ManualStall {
  reason: string;
  note: string;
  since: string;
  byId: string;
}

export interface Task {
  id: string;
  /** `${project.code}-${n}` */
  code: string;
  projectId: string;
  title: string;
  description: string;
  statusId: string;
  departmentId: string;
  assigneeId: string | null;
  createdById: string;
  followerIds: string[];
  size: TaskSize | null;
  /** ISO (YYYY-MM-DD). */
  dueDate: string | null;
  /** Settimana ISO, es. "2026-W43". */
  plannedWeek: string | null;
  slipCount: number;
  milestoneId: string | null;
  labels: string[];
  type: TaskType;
  priority: TaskPriority;
  requestId: string | null;
  /** Le righe salvate su questa task; gli inversi stanno sulle altre. */
  links: { kind: StoredLinkKind; taskId: string }[];
  attachments: { id: string; name: string; sizeBytes: number }[];
  manualStall: ManualStall | null;
  claude: ClaudeWorkState;
  createdAt: string;
  closedAt: string | null;
  lastActivityAt: string;
  /** Assente = «manual». */
  source?: TaskSource;
  /** Quante volte è arrivata la stessa segnalazione (un errore dell'SDK ripetuto): di base 1. */
  occurrences: number;
  /** Il payload dell'integrazione (chiave → valore), quando c'è. */
  technical?: Record<string, string> | null;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  description: string;
  dueDate: string | null;
  closed: boolean;
}

/**
 * Il brief settimanale di un progetto: **narrativa generata** (la scrive il
 * worker con l'AI), e la UI lo dice sempre. Forma di
 * `projectBriefWeeklySchema` di `@stubwise/shared`, ridotta ai brief pronti:
 * `summary` è il markdown intero, `headline` la prima sezione («dove siamo»).
 */
export interface WeeklyBrief {
  id: string;
  projectId: string;
  /** Estremi inclusi del periodo coperto (YYYY-MM-DD). */
  periodStart: string;
  periodEnd: string;
  headline: string;
  summary: string;
  createdAt: string;
}

/**
 * Da dove viene una voce del registro (`decisionSourceSchema`). Non esiste —
 * e non deve esistere — una sorgente «ai»: il registro dice ciò che hanno
 * deciso delle PERSONE; le voci automatiche hanno il testo di un template.
 */
export type DecisionSource = "ask_user" | "plan_review" | "pulse" | "manual" | "email";

/** Una voce del registro decisioni del progetto (`projectDecisionSchema`): un fatto. */
export interface DecisionLogEntry {
  id: string;
  projectId: string;
  source: DecisionSource;
  /** La task da cui è nata, se ce n'era una. */
  taskId: string | null;
  title: string;
  /** In che contesto è stata presa (le alternative, il perché). */
  context: string | null;
  decision: string;
  /** Chi ha deciso; `null` se la persona non c'è più. */
  decidedById: string | null;
  decidedAt: string;
  /** La voce che l'ha superata: una scelta cambiata resta un fatto accaduto. */
  supersededById: string | null;
  /**
   * Una decisione su un piano (`plan_review`) scritta dal prototipo: l'esito,
   * che il testo — un template nella lingua di chi decide — non dice a una
   * macchina. Le righe del seed non lo hanno: lo dice il loro testo.
   */
  planOutcome?: "approved" | "rejected";
}

/** Il report giornaliero di un progetto: narrativa generata, come il brief. */
export interface DailyReport {
  id: string;
  projectId: string;
  /** Il giorno (YYYY-MM-DD). */
  date: string;
  /** `null` se la sintesi della giornata non è riuscita. */
  summary: string | null;
  /**
   * Quando è stato scritto: i commit della giornata arrivati dopo non ci
   * sono («N new commits not included»). `null`: non si sa (nessun avviso).
   */
  generatedAt: string | null;
}

/** Un evento di una pull request aperta per una task (dalla pipeline di Claude o da una persona). */
export interface PullRequestEvent {
  id: string;
  projectId: string;
  taskId: string;
  kind: "pr_opened" | "pr_merged" | "pr_closed";
  at: string;
  /** Il numero della PR sulla piattaforma git. */
  number: number;
  /** Il repository (`owner/repo`): una task può avere PR su più repository. */
  repo: string;
}

/** Una PR: repository (`owner/repo`) e numero. */
export interface PrRef {
  repo: string;
  number: number;
}

/**
 * I FATTI esterni di una PR che il ciclo review → correzione legge: l'esito
 * dell'ultima review (del revisore o sulla piattaforma, con la sua data e
 * chi ha chiesto le modifiche), se il branch è protetto, se una correzione
 * chiesta è in coda. Il ciclo (giro, in corso, inviata, fallita, fermo al
 * tetto) NON si salva: lo deriva `prCycles` dalle sessioni (invariante «il
 * contatore dei giri si DERIVA, non si salva»).
 */
export interface PrFact extends PrRef {
  taskId: string;
  review: {
    verdict: "pending" | "approved" | "changes_requested";
    at: string;
    /** Chi ha chiesto le modifiche, se una persona; `null` il revisore. */
    byId: string | null;
    on: "stubwise" | "platform" | null;
  } | null;
  branchProtected: boolean;
  /** Una correzione chiesta aspetta che finisca il lavoro in corso sulla task. */
  queued: boolean;
}

/** Con chi gira una sessione di Claude: solo il NOME dell'account o della chiave, mai il segreto. */
export interface RunProvider {
  kind: "account" | "api_key";
  name: string;
}

/** I consumi di una sessione per modello (token e costo in USD). */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface ActivityEntry {
  id: string;
  taskId: string;
  kind: "comment" | "field_change" | "decision";
  authorId: string | null;
  at: string;
  body?: string;
  replyToId?: string;
  editedAt?: string;
  deletedAt?: string;
  deletedById?: string;
  field?: string;
  from?: string | null;
  to?: string | null;
  decisionRequestId?: string;
}

export interface DecisionRequest {
  id: string;
  taskId: string;
  askedById: string;
  askedOfId: string;
  question: string;
  options: string[];
  createdAt: string;
  withdrawnAt: string | null;
  answer: { optionIndex: number | null; text: string | null; at: string; byId: string } | null;
}

export type RequestStatus = "new" | "refining" | "ready" | "converted" | "archived";
export type RequestLevel = "low" | "medium" | "high";

export interface ProjectRequest {
  id: string;
  /**
   * Il codice di catalogo, `<PROGETTO>-R<n>` (R-D1): sequenza per progetto,
   * dato alla creazione e mai riusato; fuse e archiviate tengono il loro.
   */
  code: string;
  projectId: string;
  title: string;
  description: string;
  requesterIds: string[];
  status: RequestStatus;
  urgency: RequestLevel;
  /** La stima, con le stesse taglie delle task (al posto dello sforzo E1–E5 del web). */
  size?: TaskSize | null;
  risk?: RequestLevel | null;
  /** Il perché del rischio, in una riga. */
  riskNote?: string | null;
  /**
   * Il design e il piano della richiesta (markdown), scritti nel refine con
   * Claude. Il piano scritto nel refine NON è approvato: lo dice ogni vista.
   */
  design?: string | null;
  plan?: string | null;
  similarToId: string | null;
  mergedIntoId: string | null;
  taskIds: string[];
  createdAt: string;
  /**
   * Ciò che l'intake (AI) propone di cambiare nei metadati, col perché: resta
   * una proposta finché chi ha `backlog.edit` non la accetta o la scarta.
   * Assente o `null`: nessuna proposta.
   */
  suggestions?: RequestSuggestions | null;
}

/** I metadati proposti dall'intake: solo quelli che cambierebbero, e il perché. */
export interface RequestSuggestions {
  urgency?: RequestLevel;
  size?: TaskSize;
  risk?: RequestLevel;
  riskNote?: string;
  reason: string;
}

export type PeriodField = "created" | "closed" | "plannedWeek" | "due";
export type RelativePeriod =
  | "last7"
  | "last30"
  | "thisWeek"
  | "nextWeek"
  | "thisMonth"
  | "lastMonth";

export interface FilterCriteria {
  projectIds?: string[];
  departmentIds?: string[];
  assigneeIds?: (string | "none")[];
  families?: StatusFamily[];
  statusIds?: string[];
  sizes?: (TaskSize | "none")[];
  milestoneIds?: string[];
  types?: TaskType[];
  priorities?: TaskPriority[];
  stalled?: boolean;
  text?: string;
  period?: { field: PeriodField } & (
    | { kind: "relative"; preset: RelativePeriod }
    | { kind: "absolute"; from: string; to: string }
  );
}

export type TaskView = "list" | "board" | "timeline";
export type GroupBy =
  | "none"
  | "status"
  | "assignee"
  | "department"
  | "milestone"
  | "week"
  | "project";

export interface SavedFilter {
  id: string;
  name: string;
  ownerId: string;
  visibility: "private" | "public";
  criteria: FilterCriteria;
  view: TaskView;
  groupBy: GroupBy;
}

export type HomeBlockKind =
  | "decide"
  | "myWeek"
  | "myTasks"
  | "claudeForMe"
  | "stalledInMyProjects"
  | "newRequests"
  | "upcomingMilestones"
  | "filter";

export interface HomeBlockRef {
  kind: HomeBlockKind;
  filterId?: string;
}

export interface DepartmentHome {
  departmentId: string;
  blocks: HomeBlockRef[];
  updatedAt: string;
}

export interface PersonalHome {
  personId: string;
  blocks: HomeBlockRef[];
  seenDepartmentUpdates: Record<string, string>;
}

export type DepartmentPermission = "department.home.manage";

export interface DepartmentRole {
  personId: string;
  departmentId: string;
  permissions: DepartmentPermission[];
}

export interface DayArrangement {
  personId: string;
  taskId: string;
  week: string;
  day: 1 | 2 | 3 | 4 | 5 | null;
}

// --- ingressi delle mutazioni -------------------------------------------------

export interface NewTaskInput {
  projectId: string;
  title: string;
  description?: string;
  /** Se assente: il primo stato della famiglia `todo` del progetto. */
  statusId?: string;
  /** Se assente: il primo reparto di chi crea. */
  departmentId?: string;
  assigneeId?: string | null;
  size?: TaskSize | null;
  dueDate?: string | null;
  plannedWeek?: string | null;
  milestoneId?: string | null;
  labels?: string[];
  type?: TaskType;
  priority?: TaskPriority;
  requestId?: string | null;
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | "title"
    | "description"
    | "statusId"
    | "departmentId"
    | "assigneeId"
    | "size"
    | "dueDate"
    | "plannedWeek"
    | "milestoneId"
    | "labels"
    | "type"
    | "priority"
    | "followerIds"
    | "links"
    | "manualStall"
    | "attachments"
  >
>;

/**
 * I campi di una richiesta che Claude scrive in un refine (design, piano,
 * metadati): li porta la riga `work_result` che lo dice, e il motore dello
 * stream li applica alla richiesta nello stesso passo.
 */
export type RefinePatch = Partial<
  Pick<ProjectRequest, "urgency" | "size" | "risk" | "riskNote" | "design" | "plan">
>;

/** I campi di una richiesta che si cambiano col dettaglio (`backlog.edit`). */
export type RequestPatch = Partial<
  Pick<
    ProjectRequest,
    "title" | "description" | "urgency" | "size" | "risk" | "riskNote" | "suggestions"
  >
>;

export interface NewProjectInput {
  /** 2–4 maiuscole, univoco. */
  code: string;
  name: string;
  template: ProjectTemplate;
  clientName?: string;
  modules?: ProjectModule[];
}

/** Una decisione registrata a mano (`decisionDraftSchema`), con chi supera. */
export interface DecisionDraft {
  title: string;
  decision: string;
  context?: string;
  taskId?: string | null;
  /** La voce che questa supera (ne diventa il «superata da»). */
  supersedesId?: string | null;
}

export interface MilestoneInput {
  name: string;
  description?: string;
  dueDate?: string | null;
}

export type MilestonePatch = Partial<
  Pick<Milestone, "name" | "description" | "dueDate" | "closed">
>;

/**
 * Uno stato nell'elenco che sostituisce quello del progetto: con `id` se
 * esiste già. Uno stato nuovo può portare una `key` scelta da chi salva: in
 * `reassign` vale come bersaglio, così uno stesso salvataggio può togliere
 * uno stato e spostarne le task su uno appena aggiunto.
 */
export interface StatusInput {
  id?: string;
  key?: string;
  name: string;
  family: StatusFamily;
}

// --- area 3: Claude come collega ---------------------------------------------

/**
 * Il tipo di una conversazione con Claude: libera (aperta da una persona) o
 * una sessione di lavoro — esecuzione di una task, refine di una richiesta,
 * sessioni automatiche (review della PR, Docs, brief, report giornaliero,
 * classificazione della posta, stima e merge dell'intake).
 */
export type ConversationKind =
  | "free"
  | "task_run"
  | "refine"
  | "pr_review"
  | "docs"
  | "brief"
  | "daily_report"
  | "mail_classify"
  | "intake";
export type ConversationState =
  | "working"
  | "awaiting_answer"
  | "awaiting_approval"
  | "paused"
  | "idle"
  | "finished";
export type Outcome = "ok" | "failed" | "timed_out" | "stopped";

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string;
  /** Libera: chi l'ha aperta; sessione di lavoro: chi l'ha chiesta. */
  ownerId: string;
  projectId: string | null;
  /** Solo per la libera: il contesto di progetto facoltativo (decide le skill in «/»). */
  contextProjectId: string | null;
  taskId: string | null;
  requestId: string | null;
  state: ConversationState;
  /** Solo quando `state` è `finished`. */
  outcome: Outcome | null;
  /** Le sessioni di lavoro seguono il progetto (`project`); solo la libera diventa pubblica. */
  visibility: "private" | "project" | "public";
  publishedAt: string | null;
  publishedById: string | null;
  /** I progetti che Claude ha letto o toccato: l'autore li conferma quando la rende pubblica. */
  touchedProjectIds: string[];
  /**
   * Pubblica che ha toccato un progetto non confermato: da questo evento (il
   * suo indice nel flusso) in poi il flusso resta privato dell'autore finché
   * non riconferma l'elenco. `null`: tutto il flusso segue `visibility`.
   */
  privateFromIndex: number | null;
  /**
   * I progetti che l'autore ha confermato rendendola pubblica: chi non è
   * l'autore vede solo questi (un progetto toccato dopo resta suo finché
   * non lo riconferma). Vuoto se non è mai stata pubblica.
   */
  publishedProjectIds: string[];
  /** La conversazione pubblica da cui questa continua. */
  continuesFromId: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** Solo sessione di lavoro: con quale account o chiave gira (il nome). */
  provider?: RunProvider | null;
  /** Solo sessione di lavoro: i consumi per modello. */
  usage?: ModelUsage[];
  /** Solo sessione di lavoro fallita: il riassunto del fallimento, in una riga. */
  failureSummary?: string | null;
}

export interface Attachment {
  id: string;
  name: string;
  sizeBytes: number;
  kind: "image" | "file";
}

/** Una modifica ai dati che Claude propone: la esegue la mutazione di oggi, a nome di chi conferma. */
export type ProposedAction = {
  fn:
    | "createTask"
    | "updateTask"
    | "planTask"
    | "addComment"
    | "createRequest"
    | "convertRequest"
    | "startRun"
    | "archiveRequest";
  args: Record<string, unknown>;
  summary: string;
};

/**
 * Un oggetto citato nel flusso: `file` ha id `<repo>:<percorso>`, gli altri
 * l'id dell'oggetto. `milestone`, `brief` e `release` (area 4) li citano le
 * schede degli eventi di progetto nella Chat.
 */
export type CitationRef = {
  kind:
    | "task"
    | "request"
    | "doc"
    | "file"
    | "project"
    | "person"
    | "milestone"
    | "brief"
    | "release";
  id: string;
};

export type ConversationEvent =
  | {
      id: string;
      at: string;
      type: "user";
      authorId: string;
      text: string;
      attachments: Attachment[];
      delivery: "pending" | "delivered" | "undelivered";
      undeliveredReason?: string;
    }
  /** `text` cresce mentre arriva; `done` quando il messaggio è completo. */
  | { id: string; at: string; type: "assistant"; text: string; done: boolean }
  | {
      id: string;
      at: string;
      type: "action";
      tool: string;
      label: string;
      input?: string;
      result?: string;
      state: "running" | "done" | "failed";
      truncated?: boolean;
    }
  | {
      id: string;
      at: string;
      type: "phase";
      phase: string;
      outcome: Outcome | null;
      stoppedById?: string;
      /** Chi l'ha chiusa («Close the session» di un refine). */
      closedById?: string;
      /** `item_closed`: il refine si è chiuso perché la richiesta è stata trasformata, archiviata o fusa. */
      reason?: "item_closed";
      /** Solo una fase `correction`: la PR che corregge (il job del server la conosce). */
      pr?: PrRef;
    }
  | { id: string; at: string; type: "citation"; refs: CitationRef[] }
  | {
      id: string;
      at: string;
      type: "question";
      questionId: string;
      text: string;
      options: { label: string; consequence?: string; recommended?: boolean }[];
      answer: { optionIndex: number | null; text: string | null; byId: string; at: string } | null;
    }
  | {
      id: string;
      at: string;
      type: "plan";
      planText: string;
      summary: string;
      status: "pending" | "approved" | "rejected" | "pre_approved";
      decidedById?: string;
      instructions?: string;
    }
  | {
      id: string;
      at: string;
      type: "proposal";
      proposalId: string;
      requesterId: string;
      actions: ProposedAction[];
      status: "open" | "confirmed" | "cancelled" | "expired" | "failed";
      error?: string;
      resultCodes?: string[];
      /** Confermata solo in parte («Confirm selected»): gli indici delle azioni eseguite. */
      confirmedActions?: number[];
      /** Eseguita dal dialogo di «Modifica», con i valori cambiati da chi l'ha chiesta. */
      edited?: boolean;
    }
  | {
      id: string;
      at: string;
      type: "work_result";
      kind:
        | "pr_opened"
        | "review"
        | "correction"
        | "design_updated"
        | "plan_updated"
        | "estimate_updated";
      text: string;
      link?: string;
      /** Nel refine: i campi della richiesta che questa riga ha scritto (già eseguito). */
      requestPatch?: RefinePatch;
    };

/** Il contenuto di un evento senza id né data: li dà il motore dello stream quando lo emette. */
export type EventDraft = ConversationEvent extends infer E
  ? E extends ConversationEvent
    ? Omit<E, "id" | "at">
    : never
  : never;

/**
 * Cosa cambia di un evento già nel flusso: porta il suo `type` e solo i
 * campi di quel tipo (mai id, data o tipo diversi).
 */
export type EventPatch = ConversationEvent extends infer E
  ? E extends ConversationEvent
    ? { type: E["type"] } & Partial<Omit<E, "id" | "at" | "type">>
    : never
  : never;

/**
 * Un passo di quello che Claude fa in una conversazione, come lo esegue il
 * motore dello stream (`data/stream.ts`, `runScript`): l'unico modo in cui
 * un evento entra nel flusso o cambia.
 * - `say`: un messaggio, che arriva a pezzi di 3–12 parole sullo stesso evento;
 * - `action`: un'azione, prima `running` poi `done` (o `failed`);
 * - `finish_action`: chiude l'ultima azione rimasta `running` nel flusso;
 * - `deliver`: i messaggi delle persone ancora `pending` diventano `delivered`;
 * - `event`: un evento intero (fase, citazione, domanda, piano, proposta, risultato);
 * - `patch`: cambia un evento già nel flusso (risposta, decisione, stato di una proposta);
 * - `state`: lo stato della conversazione (e l'esito, quando finisce).
 */
export type ScriptStep =
  | { step: "say"; text: string }
  | {
      step: "action";
      tool: string;
      label: string;
      input?: string;
      result?: string;
      outcome?: "done" | "failed";
      truncated?: boolean;
    }
  | { step: "finish_action"; result?: string; outcome?: "done" | "failed" }
  | { step: "deliver" }
  | { step: "event"; event: EventDraft }
  | { step: "patch"; eventId: string; patch: EventPatch }
  | { step: "state"; state: ConversationState; outcome?: Outcome | null };

/** Un comando di «/»: di Stubwise o la skill di un plugin abilitato nel progetto. */
export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  source: "stubwise" | { plugin: string; skill: string };
}

/** Un commit della giornata, per la rassegna per persona; `authorId` null = autore non collegato. */
export interface CommitOfDay {
  sha: string;
  repo: string;
  authorId: string | null;
  authorName: string;
  message: string;
  /** Testo generato (come `commit_summaries`): la UI lo etichetta «Testo generato». */
  aiSummary: string;
  at: string;
  projectId: string;
}

/** Una pagina dei Docs di un progetto, quanto basta per citarla e cercarla. */
export interface DocPage {
  id: string;
  projectId: string;
  title: string;
  /** Dove sta nella sezione Docs, es. «Guide / Callbacks». */
  path: string;
  excerpt: string;
}

/**
 * Una pagina di Release, quanto basta perché la scheda di un evento della
 * Chat la citi. Le pagine vere arrivano con l'area 8: fino ad allora sono
 * finte, del seme.
 */
export interface ReleasePage {
  id: string;
  projectId: string;
  /** Es. «0.9.0». */
  version: string;
  title: string;
  /** Il riassunto in una riga, per la scheda. */
  summary: string;
  publishedAt: string;
  publishedById: string;
}

// --- Chat (area 4) -----------------------------------------------------------

/**
 * Di progetto (appartiene a un progetto), generale (dell'azienda) o messaggio
 * diretto (2–8 persone, privato per costruzione).
 */
export type ChannelKind = "project" | "general" | "dm";

/** Gli eventi di progetto che un canale può pubblicare come messaggi di sistema. */
export type ChatEventKind =
  | "release_page"
  | "pr_opened"
  | "pr_merged"
  | "milestone_reached"
  | "brief_ready"
  | "request_new"
  | "task_closed";

export interface Channel {
  id: string;
  kind: ChannelKind;
  /** Solo i canali di progetto. */
  projectId: string | null;
  /** Senza «#» né codice: la UI mostra `AUD · general`. Vuoto per un DM (lo dicono i membri). */
  name: string;
  description: string;
  topic: string;
  /** Un DM è sempre `private`. */
  visibility: "open" | "private";
  createdById: string;
  /** Archiviato: resta leggibile a chi lo vedeva, in sola lettura. */
  archived: boolean;
  /** Chi l'ha archiviato e quando (la fascia «archived by X on date»); `null` se non archiviato. */
  archivedById: string | null;
  archivedAt: string | null;
  /** Il «general» di un progetto: ne comprende tutti i membri e non si lascia. */
  isGeneral: boolean;
  memberIds: string[];
  /** Quali eventi del progetto arrivano qui (vuoto fuori dai canali di progetto). */
  publishedEvents: ChatEventKind[];
  createdAt: string;
}

/**
 * Un messaggio della Chat: di una persona, di sistema (un evento di
 * progetto, con la scheda dell'oggetto) o una risposta di @Claude (sempre
 * nel thread; `calledById` = chi l'ha chiamato, con i suoi permessi).
 * Eliminato: `text` vuoto, senza allegati né citazioni (stessa regola dei
 * commenti: il testo sparisce ovunque).
 */
export interface ChatMessage {
  id: string;
  channelId: string;
  /** Il messaggio radice del thread; `null` = nel canale. */
  threadOf: string | null;
  /** `null` = sistema; una risposta di Claude ha l'id di Claude. */
  authorId: string | null;
  kind: "person" | "system" | "claude";
  /** Solo `claude`: chi l'ha chiamato. */
  calledById?: string;
  /**
   * Markdown; le menzioni come le scrive la casella: `@Nome Cognome`,
   * `@channel`, `@<Reparto>`, `@Claude`.
   */
  text: string;
  attachments: Attachment[];
  citations: CitationRef[];
  reactions: { emoji: string; personIds: string[] }[];
  /** Le persone a cui il messaggio chiede una risposta (vanno in «Da decidere»). */
  asksReplyOf: string[];
  /** Una risposta del thread mostrata anche nel canale («Rispondi anche nel canale»). */
  alsoInChannel?: boolean;
  /** Solo `system`: l'evento e l'oggetto della scheda. */
  event?: { kind: ChatEventKind; ref: CitationRef };
  /** Task e richieste nate da questo messaggio («→ AUD-14»). */
  linkedCodes: string[];
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  deletedById: string | null;
  /**
   * Solo `claude`: le righe d'azione e le schede (proposte) della risposta.
   * Il testo è `text` (con le citazioni in `citations`), come per un
   * messaggio di una persona.
   */
  claudeEvents?: ConversationEvent[];
  /**
   * Solo `claude` chiamato dal vivo (senza = una risposta finita del seme):
   * il messaggio che l'ha chiamato e a che punto è. `waiting` = Claude ha
   * fatto una domanda a chi l'ha chiamato (una riga `question` aperta in
   * `claudeEvents`) e aspetta la risposta; `stopped` = fermata da chi l'ha
   * chiamato; `failed` con il codice del motivo (la UI lo dice nella sua
   * lingua, mai un testo grezzo), e «Try again» per chi l'ha chiamato
   * finché non l'ha già rifatta (`retried`).
   */
  claudeRun?: {
    callMessageId: string;
    state: "working" | "waiting" | "done" | "stopped" | "failed";
    errorCode?: ChatClaudeFailure;
    retried?: boolean;
  };
}

/**
 * Perché una risposta di @Claude non è finita: chi l'ha chiamato non legge
 * più il canale (`forbidden`), qualcosa che serviva non c'è più
 * (`not_found`), o un errore qualunque (`other`).
 */
export type ChatClaudeFailure = "forbidden" | "not_found" | "other";

/** Fin dove una persona ha letto un canale e, per id della radice, i thread. */
export interface ReadState {
  personId: string;
  channelId: string;
  lastReadAt: string;
  threadReads: Record<string, string>;
}

/** Le notifiche di un canale per una persona: tutti i messaggi, solo menzioni, silenziato. */
export type NotifyLevel = "all" | "mentions" | "muted";

/** La preferenza di una persona su un canale; senza riga vale `all`. */
export interface ChannelNotifyPref {
  personId: string;
  channelId: string;
  level: NotifyLevel;
}

/**
 * Un passo del flusso di un canale o di un thread della Chat, eseguito dal
 * motore dello stream (`runScript` su `chat:<canale>` o `chat:thread:<radice>`):
 * l'unico modo in cui un messaggio entra nella Chat o cambia dal vivo.
 * - `post`: un messaggio intero (con id e data), in fondo;
 * - `patch`: cambia campi di un messaggio già scritto (mai id, canale o thread);
 * - `say`: il testo di un messaggio (una risposta di @Claude) arriva a pezzi.
 */
export type ChatScriptStep =
  | { step: "post"; message: ChatMessage }
  | {
      step: "patch";
      messageId: string;
      patch: Partial<Omit<ChatMessage, "id" | "channelId" | "threadOf">>;
    }
  | { step: "say"; messageId: string; text: string };
