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
  /**
   * I destinatari fissi: valgono solo per i kind FUORI dal catalogo degli
   * avvisi (area 8a). Per quelli del catalogo chi lo riceve si calcola a
   * lettura (iscrizioni, `mandatory`, permessi di adesso) e qui resta `[]`.
   */
  recipientIds: string[];
  /** Kind del catalogo: chi lo riceve senza iscrizione, col perché (chiave i18n). */
  mandatory?: { personId: string; reason: MandatoryReason }[];
  title: string;
  body: string;
  createdAt: string;
  /**
   * Solo gli avvisi del catalogo pubblicati nella sessione: l'ordine monotono
   * condiviso con le voci delle iscrizioni (R-K19). Il seme non lo ha.
   */
  seq?: number;
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

/** Perché un avviso del catalogo arriva a qualcuno senza iscrizione (area 8a). */
export type MandatoryReason =
  | "merged"
  | "pr_author"
  | "follows_conversation"
  | "task_author"
  | "assignee";

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
 * webhook, widget), dalla posta, da un'automazione o dall'analisi di un
 * server (area 8b). Al posto di `source` del ticket del web (dove l'SDK
 * distingue errore e feedback).
 */
export type TaskSource =
  | "manual"
  | "sdk"
  | "api"
  | "slack"
  | "webhook"
  | "widget"
  | "email"
  | "automation"
  | "server";

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
  /** Creata da un'esecuzione di un'automazione (area 7): «Creata dall'automazione X · esecuzione Y». */
  automationRef?: AutomationRef;
  /** Creata da «Fai sistemare a Claude» su un rilascio fallito (area 8a). */
  releaseRef?: { releaseId: string };
  /**
   * Legata a un server (area 8b): la apre l'analisi automatica di un
   * episodio. È l'unica porta della correzione da task (anti-obiettivo 2).
   */
  serverRef?: { serverCode: string; episodeId: string | null };
}

/** L'automazione e l'esecuzione che hanno creato una task o un traguardo (area 7). */
export interface AutomationRef {
  automationId: string;
  runId: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  description: string;
  dueDate: string | null;
  closed: boolean;
  /** Creato da un'esecuzione di un'automazione (area 7). */
  automationRef?: AutomationRef;
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
  /**
   * Da dove è nata, se non a mano: una conversazione di Support (widget o
   * server MCP, area 8a). Una richiesta non nasce MAI da un'email.
   */
  origin?: { kind: "support"; conversationId: string };
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
  | "upcomingEvents"
  | "importantMail"
  | "automations"
  | "releases"
  | "waitingCustomers"
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
 * classificazione della posta, stima e merge dell'intake, analisi di un
 * server in sola lettura — area 8b).
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
  | "intake"
  | "server_analysis";
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
  /**
   * Solo libera: l'oggetto di contesto con cui è nata («Chiedi a Claude di
   * spiegarlo» su un rilascio, area 8a). Resta di chi la apre (privacy area 3).
   */
  context?: { kind: "release"; releaseId: string } | null;
  /**
   * Solo `task_run`: la correzione di un server (area 8b), avviata da una
   * task con `serverRef`. Il suo piano va sempre approvato da una persona.
   */
  serverFix?: { serverCode: string };
}

export interface Attachment {
  id: string;
  name: string;
  sizeBytes: number;
  kind: "image" | "file";
}

/**
 * Una frase di Claude registrata come chiave i18n e parametri, non come
 * testo: si legge nella lingua di chi guarda, adesso. I parametri sono dati
 * (codici, titoli, nomi), mai frasi.
 */
export type Utterance = { key: string; params?: Record<string, string | number> };

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
    | "archiveRequest"
    // Dalla posta (area 6): una decisione nel registro (origine `email`, testo
    // da template), un traguardo, e la scelta del progetto per un'email
    // incerta (`chooseProject` non si esegue: la risolve `chooseProjectFor`).
    | "recordDecision"
    | "createMilestone"
    | "chooseProject"
    // Dal calendario (area 6): «Ricordamelo» di una serie. Non crea nulla:
    // chi la conferma prende atto e la proposta si chiude (come
    // `acknowledge_reminder` del web).
    | "acknowledgeReminder";
  args: Record<string, unknown>;
  summary: string;
  /** Il riassunto come frase (`summary` è la sua resa al momento, per chi non la sa leggere). */
  summaryText?: Utterance;
};

/**
 * Un oggetto citato nel flusso: `file` ha id `<repo>:<percorso>`, gli altri
 * l'id dell'oggetto. `milestone`, `brief` e `release` (area 4) li citano le
 * schede degli eventi di progetto nella Chat. `drive` (area 5) è un file del
 * Drive di un progetto (l'id del riferimento, codice `AUD-F7`): non va
 * confuso con `file`, che resta il file di un repository.
 */
export type CitationRef = {
  kind:
    | "task"
    | "request"
    | "doc"
    | "file"
    | "drive"
    | "project"
    | "person"
    | "milestone"
    | "brief"
    | "release";
  id: string;
  /**
   * Solo `drive`: il codice del file al momento della citazione (`AUD-F7`).
   * Un riferimento tolto dal Drive non c'è più nello stato, ma la citazione
   * registrata ricorda il suo codice: chi non può aprirlo legge lo stesso
   * codice tenue per ogni causa — progetto invisibile, nascosto, tolto (R-H5).
   */
  code?: string;
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
      /** L'etichetta come frase: chi guarda la legge nella sua lingua (`label` resta la resa al momento). */
      labelText?: Utterance;
      input?: string;
      result?: string;
      resultText?: Utterance;
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
        | "estimate_updated"
        // Area 8b: la diagnosi dell'analisi di un server, il controllo finale della correzione.
        | "server_diagnosis"
        | "server_check";
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
      labelText?: Utterance;
      input?: string;
      result?: string;
      resultText?: Utterance;
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

// --- Docs (area 5) -----------------------------------------------------------

/** Un repository collegato a un progetto: ognuno ha il suo spazio dei Docs. */
export interface Repository {
  id: string;
  projectId: string;
  /** Il nome del repository sulla piattaforma, es. «audin-app»; unico nel progetto: è nell'indirizzo dei Docs. */
  name: string;
  /** `owner/repo`, come nei `PrRef` (area 8a). */
  fullName?: string;
  /** Le PR dei colleghi (aperte fuori da Stubwise): analisi e correzioni, solo analisi o spento. */
  colleaguePrs?: ColleaguePrMode;
  /**
   * Il ramo di default sulla piattaforma (assente = `main`). È un fatto del
   * repository, non una scelta di Stubwise: cambiare il ramo di rilascio non
   * lo sposta, e Claude non ci spinge mai (anti-obiettivo 4, R-K20).
   */
  defaultBranch?: string;
  /** Il ramo su cui si rilascia (il merge), es. «main». */
  releaseBranch?: string;
  /** Quali run di CI fanno lo stato del rilascio: tutte, o solo quelle coi nomi dati. */
  releasePipeline?: { mode: "auto" } | { mode: "named"; names: string[] };
  /** Da dove si leggono le run; `null` = nessuna pipeline (lo stato lo dice l'ambiente). */
  ciProvider?: "github_actions" | "bitbucket_pipelines" | null;
}

/** Le quattro categorie dell'albero; `manual` = scritta a mano, le altre generate. */
export type DocKind = "technical" | "functional" | "product" | "manual";

/** Un commit arrivato dopo l'ultimo aggiornamento della pagina («pagina vecchia»). */
export interface DocStaleCommit {
  sha: string;
  message: string;
  at: string;
}

export interface DocLink {
  type: "implements" | "implemented_by" | "related";
  pageId: string;
}

/**
 * Una pagina dei Docs, nello spazio del suo repository. `code` (`AUD-D12`) è
 * stabile: non cambia col titolo né col percorso, e non si riusa dopo
 * un'eliminazione.
 */
export interface DocPage {
  id: string;
  code: string;
  projectId: string;
  repositoryId: string;
  kind: DocKind;
  title: string;
  /** Unico nello spazio: la pagina si apre per `slug`. */
  slug: string;
  /** Dove sta nell'albero della categoria, es. «Guide / Dialer». */
  path: string;
  excerpt: string;
  /** Markdown. */
  body: string;
  /** La parte del codice che la pagina documenta («documents src/import»); `null` per le manuali. */
  documentsPath: string | null;
  /** `null` per le manuali. */
  generatedAtCommit: string | null;
  updatedAt: string;
  staleCommits: DocStaleCommit[];
  links: DocLink[];
  /** Le visite («più lette»): nessun legame con le aperture del Drive. */
  views: number;
}

/** Lo stato della generazione dei Docs di un repository (pannello in fondo allo spazio). */
export interface DocGeneration {
  status: "never" | "queued" | "running" | "succeeded" | "failed" | "held" | "paused";
  lastAt: string | null;
  commit: string | null;
  costUsd: number | null;
  /** Il provider fissato per il repository. */
  provider: string | null;
  /**
   * Perché è fallita, trattenuta o in pausa: un codice, che la UI dice nella
   * lingua di chi guarda (`docs.generation.reasons.<codice>`).
   */
  reason: DocGenerationReason | null;
  /** In pausa sul limite d'uso: quando riprende da sola, circa. */
  resumesAt?: string | null;
  /** In corso: le pagine scritte su un totale stimato. */
  progress?: { done: number; total: number } | null;
}

export type DocGenerationReason =
  | "usage_limit"
  | "monthly_budget"
  | "provider_error"
  | "worker_restart";

export type GraphFailureReason = "graphify_error" | "repository_too_large";

/**
 * Una comunità del grafo: il nome lo scrive l'AI (le «etichette AI» del
 * web), `nodes` sono i nodi più collegati, `links` le comunità vicine.
 */
export interface GraphCommunity {
  id: string;
  name: string;
  size: number;
  summary: string;
  nodes: string[];
  links: string[];
}

/** Il grafo del codice (graphify) di un repository. */
export type GraphState = {
  status: "disabled" | "never" | "queued" | "running" | "failed" | "ready";
  reason?: GraphFailureReason;
  nodes?: number;
  edges?: number;
  communities?: number;
  /** L'ultima costruzione (si rifà a ogni push). */
  updatedAt?: string;
  /** Il resoconto delle comunità, dalla più grande: c'è quando il grafo è pronto. */
  report?: GraphCommunity[];
  setupPr?: { url: string; open: boolean };
};

/** Il brief del repository: le sezioni del web, più i fatti riservati e le pagine escluse. */
export interface RepoBrief {
  identity: string;
  actors: { name: string; description: string }[];
  /** Le superfici del prodotto, con chi le usa. */
  surfaces: { name: string; audience: string }[];
  glossary: { term: string; definition: string }[];
  /** Invarianti di business. */
  invariants: string[];
  /** I percorsi dell'utente. */
  journeys: { name: string; steps: string[] }[];
  /** Le fonti già esistenti da cui la generazione parte. */
  sources: { label: string; path: string }[];
  /** Mostrati per verifica: cosa, perché, dove nel codice, come non deve comparire. */
  confidentialFacts: { fact: string; reason: string; where: string; mustNotAppearAs: string }[];
  /** Pagine tenute fuori dai Docs pubblici, col motivo. */
  excludedPages: { title: string; reason: string }[];
}

/** Una voce di Releases dei Docs (scritta la notte): `minor` = non significativa. */
export interface DocRelease {
  id: string;
  version: string;
  date: string;
  /** Markdown. */
  text: string;
  minor: boolean;
  /** Le pagine toccate. */
  pageIds: string[];
}

export interface DocSpace {
  repositoryId: string;
  projectId: string;
  /** Il nome del repository. */
  name: string;
  generation: DocGeneration;
  brief: RepoBrief | null;
  releases: DocRelease[];
  graph: GraphState;
}

/** Una pagina in un elenco (albero, recenti, più lette, ricerca): senza il corpo. */
export interface DocPageRef {
  id: string;
  code: string;
  projectId: string;
  repositoryId: string;
  kind: DocKind;
  title: string;
  slug: string;
  path: string;
  excerpt: string;
  updatedAt: string;
  views: number;
  /** Ha commit successivi all'ultimo aggiornamento. */
  stale: boolean;
}

/** Cosa chi guarda può fare in uno spazio: la UI legge i flag, non li deduce. */
export interface DocSpacePermissions {
  /** Creare, modificare, eliminare le pagine manuali (`docs.edit`). */
  edit: boolean;
  /** «Genera la documentazione», «Riprendi ora» (`docs.generate`). */
  generate: boolean;
  /** Le azioni del grafo (`repos.manage`). */
  manageRepository: boolean;
}

/** Uno spazio come lo legge chi guarda. */
export interface DocSpaceView extends DocSpace {
  pageCount: number;
  /** Solo pagine manuali (nessuna pagina generata). */
  manualOnly: boolean;
  /** Aggiornate di recente (al più 5). */
  recent: DocPageRef[];
  /** Più lette, dalle visite (al più 5, solo quelle visitate). */
  mostRead: DocPageRef[];
  permissions: DocSpacePermissions;
  /** La chat dei Docs c'è (serve un provider con chiave API). */
  chatAvailable: boolean;
  /** Le pagine da cui nascono le domande suggerite della chat (al più 4). */
  chatSuggestions: DocPageRef[];
}

/** Un nodo dell'albero: una cartella del percorso o una pagina (foglia). */
export interface DocTreeNode {
  name: string;
  page: DocPageRef | null;
  children: DocTreeNode[];
}

export interface DocTreeCategory {
  kind: DocKind;
  count: number;
  nodes: DocTreeNode[];
}

/** Una pagina aperta, coi collegamenti risolti (solo verso pagine che chi guarda vede). */
export interface DocPageView extends DocPage {
  repositoryName: string;
  resolvedLinks: { type: DocLink["type"]; page: DocPageRef }[];
  permissions: { edit: boolean; delete: boolean };
}

/** Una voce di «Novità» della pagina iniziale: una release col suo spazio. */
export interface DocReleaseRow extends DocRelease {
  repositoryId: string;
  repositoryName: string;
}

/** La pagina iniziale dei Docs di un progetto. */
export interface ProjectDocsHome {
  projectId: string;
  /** L'identità dal brief del repository principale. */
  identity: string | null;
  /** «Inizia da qui»: il brief e l'indice del repository principale. */
  startHere: { repositoryId: string; name: string; hasBrief: boolean } | null;
  spaces: DocSpaceView[];
  /** Sintesi del registro decisioni (il registro intero sta in Overview). */
  decisions: { total: number; recent: DecisionLogEntry[] };
  /** «Novità»: le releases di tutti gli spazi, dalla più recente (al più 5). */
  whatsNew: DocReleaseRow[];
  /** La chat del progetto c'è (serve un provider con chiave API). */
  chatAvailable: boolean;
  /** Le pagine da cui nascono le domande suggerite (al più 4, da tutti gli spazi). */
  chatSuggestions: DocPageRef[];
}

export interface DocSearchHit {
  page: DocPageRef;
  repositoryName: string;
  projectCode: string;
  /** Il passaggio che ha corrisposto (dal corpo o dall'estratto), una riga. */
  passage: string;
}

/** Una domanda alla chat dei Docs: del progetto, o di un solo repository. */
export interface DocsQuestion {
  projectId: string;
  repositoryId?: string;
  question: string;
}

/** La risposta della chat dei Docs: Markdown, le pagine citate e il loro spazio. */
export interface DocsAnswer {
  /** Quando ha risposto (orologio del prototipo). */
  answeredAt: string;
  text: string;
  refs: CitationRef[];
  sources: { pageId: string; repositoryName: string }[];
}

export interface ManualPageInput {
  title: string;
  /** Facoltativo: se manca si ricava dal titolo. */
  slug?: string;
  /** Markdown. */
  body: string;
  /** Dove sta nell'albero delle manuali; vuoto = in cima alla categoria. */
  path?: string;
}

export type GraphActionKind = "generate" | "regenerate" | "rebuild" | "setup_pr";

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

// --- Drive (area 5) ----------------------------------------------------------

/** Il tipo di un file del Drive, come lo filtra l'elenco. */
export type DriveFileType = "document" | "sheet" | "slides" | "pdf" | "image" | "other";

/**
 * A che punto è il contenuto di un file: in elaborazione, pronto (testo
 * estratto), nessun testo (un'immagine senza scritte), formato non
 * supportato, errore di estrazione.
 */
export type ContentState = "processing" | "ready" | "no_text" | "unsupported" | "error";

/**
 * Un file del Drive di un progetto: caricato in Stubwise (`upload`) o
 * riferimento a un file di Google Drive (`google`). `code` (`AUD-F7`) è uno
 * per riferimento: lo stesso file Google in due progetti ha due codici. Un
 * file di una cartella collegata (`folderLinkId`) risulta aggiunto da chi
 * l'ha collegata; non si toglie, si nasconde (`hidden`). `unavailable` =
 * cancellato su Google o accesso perso: resta in elenco con la causa.
 */
export interface DriveFile {
  id: string;
  code: string;
  projectId: string;
  source: "upload" | "google";
  name: string;
  type: DriveFileType;
  mime: string;
  /** `null` per i documenti nativi di Google (nessuna dimensione). */
  sizeBytes: number | null;
  addedById: string;
  addedAt: string;
  modifiedAt: string;
  folderLinkId: string | null;
  googleFileId: string | null;
  /** L'email del proprietario su Google. */
  googleOwner: string | null;
  hidden: boolean;
  unavailable: null | "deleted" | "access_lost";
  content: ContentState;
  /** Il testo estratto (vuoto finché non c'è): è quello che leggono ricerca e Claude. */
  text: string;
  summary: string | null;
  /** Il testo viene dall'OCR (un PDF scansionato). */
  ocr: boolean;
}

/**
 * Un'apertura contata: anteprima di un caricato, «Apri in Google Drive»,
 * download. La stessa persona sullo stesso riferimento entro 30 minuti è una.
 */
export interface DriveOpen {
  fileId: string;
  personId: string;
  at: string;
  via: "preview" | "google" | "download";
}

/** L'account Google personale di una persona; senza riga = non collegato. */
export interface GoogleAccount {
  personId: string;
  email: string;
  status: "connected" | "expired";
  /** Da quando vale lo stato: collegato dal…, scaduto il… */
  since: string;
}

/**
 * Una cartella Google collegata a un progetto: Stubwise la legge con
 * l'account di chi l'ha collegata, e tutti i membri ne leggono i file.
 */
export interface FolderLink {
  id: string;
  projectId: string;
  name: string;
  googleFolderId: string;
  linkedById: string;
  linkedAt: string;
  status: "ok" | "expired";
  /** Quando ha smesso di aggiornarsi (`expired`), altrimenti `null`. */
  expiredAt: string | null;
}

/**
 * Un file di Google Drive che non è in nessun progetto: lo trova dalla
 * ricerca solo chi ha l'account collegato e lo vede su Google.
 */
export interface GoogleOutsideFile {
  googleFileId: string;
  name: string;
  type: DriveFileType;
  visibleToPersonIds: string[];
  text: string;
  summary: string;
}

/**
 * Una cartella di Google Drive come la vede Google (simulato): la sceglie il
 * selettore di «Collega una cartella». `path` sono le briciole sopra di lei
 * («My Drive › Clienti»); la vede chi è in `visibleToPersonIds`.
 */
export interface GoogleFolder {
  googleFolderId: string;
  name: string;
  path: string[];
  visibleToPersonIds: string[];
}

/**
 * Un file di Google Drive come lo vede Google (simulato): la fonte da cui
 * collegare, aggiungere e risincronizzare i riferimenti. Il contenuto è
 * quello finale (il riferimento passa da `processing` prima di averlo);
 * `deleted` = cancellato su Google. Lo vede chi vede la sua cartella o chi
 * è in `visibleToPersonIds`.
 */
export interface GoogleDriveFile {
  googleFileId: string;
  googleFolderId: string | null;
  name: string;
  type: DriveFileType;
  mime: string;
  sizeBytes: number | null;
  owner: string;
  modifiedAt: string;
  deleted: boolean;
  content: Exclude<ContentState, "processing">;
  text: string;
  summary: string | null;
  ocr: boolean;
  visibleToPersonIds: string[];
}

/** Gli ordinamenti del Drive: «Più usati» (predefinito), Recenti, Nome. */
export type DriveSort = "most_used" | "recent" | "name";

/** I filtri dell'elenco del Drive; `hidden: true` = solo i nascosti (chi ha `drive.manage`). */
export interface DriveFilters {
  projectId?: string;
  type?: DriveFileType;
  source?: DriveFile["source"];
  addedById?: string;
  hidden?: boolean;
  sort: DriveSort;
}

/** Cosa può fare chi guarda su un file: lo calcola il «server», il client lo legge. */
export interface DriveFilePermissions {
  /** Eliminare un caricato: il proprio, o con `drive.manage`. */
  delete: boolean;
  /** Togliere un Google: aggiunto da me, o `drive.manage`; un file di cartella solo se non disponibile. */
  remove: boolean;
  /** Nascondere/rimostrare un file di cartella (`drive.manage`). */
  hide: boolean;
  /** «Riprova» l'estrazione di un contenuto in errore (`drive.manage`). */
  retry: boolean;
}

/**
 * Una riga del Drive: il file senza il testo estratto, con le aperture degli
 * ultimi 90 giorni, la prima riga del riassunto e la cartella (il gruppo).
 */
export interface DriveFileRow extends Omit<DriveFile, "text"> {
  projectCode: string;
  opens90d: number;
  /** L'ultima apertura contata, di chiunque (per «Recenti»). */
  lastOpenedAt: string | null;
  summaryLine: string | null;
  folder: { id: string; name: string; status: FolderLink["status"] } | null;
  /** Chi l'ha nascosto e quando (solo per un nascosto). */
  hiddenBy: { personId: string; at: string } | null;
  permissions: DriveFilePermissions;
}

/**
 * Il dettaglio di un file: la riga, il totale da sempre e lo storico delle
 * aperture (più recenti in alto) — `null` senza `drive.history`.
 */
export interface DriveFileDetail extends DriveFileRow {
  opensTotal: number;
  history: DriveOpen[] | null;
}

/** Dove cerca la ricerca del Drive: i filtri dell'elenco, senza ordinamento né nascosti. */
export type DriveSearchScope = Omit<DriveFilters, "sort" | "hidden">;

/**
 * Un risultato della ricerca del Drive: la riga del file e il passaggio del
 * testo che corrisponde — `null` se ha corrisposto solo il nome (o il codice).
 */
export interface DriveSearchHit {
  file: DriveFileRow;
  passage: string | null;
}

/** Un file Google fuori dai progetti trovato dalla ricerca: senza codice (non è un riferimento). */
export interface GoogleOutsideHit {
  googleFileId: string;
  name: string;
  type: DriveFileType;
  owner: string;
  modifiedAt: string;
  summary: string;
  passage: string | null;
}

/** La ricerca del Drive: i file dei progetti per pertinenza, poi quelli fuori dai progetti. */
export interface DriveSearchResult {
  files: DriveSearchHit[];
  outside: GoogleOutsideHit[];
}

/** Una cartella collegata con quanti file porta nel progetto (non nascosti). */
export interface FolderLinkView extends FolderLink {
  fileCount: number;
  /**
   * I suoi file sono non disponibili per accesso perso: l'account di chi
   * l'ha collegata è stato scollegato (non solo scaduto il collegamento).
   */
  accessLost: boolean;
}

/** Una cartella nel selettore di «Collega una cartella». */
export interface GoogleFolderChoice {
  googleFolderId: string;
  name: string;
  path: string[];
  fileCount: number;
  alreadyLinked: boolean;
}

/** Un file nel selettore di «Aggiungi da Google Drive». */
export interface GoogleFileChoice {
  googleFileId: string;
  name: string;
  type: DriveFileType;
  owner: string;
  modifiedAt: string;
  alreadyInProject: boolean;
}

/** Un file scelto dal disco: nome, tipo e dimensione letti nel renderer. */
export interface DriveUploadInput {
  name: string;
  mime: string;
  sizeBytes: number;
}

/** L'esito del caricamento di un file: la riga nuova, o perché no. */
export interface DriveUploadResult {
  name: string;
  file: DriveFileRow | null;
  error: "too_large" | null;
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

// --- Posta (area 6) ----------------------------------------------------------

/** Un indirizzo di posta; `personId` se è di una persona del team in Stubwise. */
export interface MailAddress {
  name: string;
  email: string;
  personId: string | null;
}

/**
 * La casella Gmail di una persona (serve l'account Google collegato).
 * `proposalsEnabled` = «Proposte attive per questa casella»: spento, la sua
 * posta non va al modello. `syncedAt` dice quanto è aggiornata.
 */
export interface Mailbox {
  personId: string;
  email: string;
  proposalsEnabled: boolean;
  syncedAt: string;
  sync: "ok" | "syncing" | "failed";
}

export type MailImportance = "high" | "normal" | "low";

/**
 * L'esito del modello su un'email: `off` = casella con le proposte spente,
 * `pending` = in analisi, `failed` = analisi fallita («Riproponi»). `done`:
 * i progetti (anche nessuno: newsletter, personali), l'importanza, la
 * scadenza ricavata e i progetti fra cui è incerto (→ `chooseProject`).
 */
export type MailClassification =
  | { state: "off" | "pending" | "failed" }
  | {
      state: "done";
      projectIds: string[];
      importance: MailImportance;
      dueDate: string | null;
      uncertainProjectIds: string[];
    };

/**
 * Un messaggio. La stessa email arrivata a più caselle è UNA riga (stesso
 * Message-ID), con le caselle che la contengono in `mailboxPersonIds`. La
 * vedono solo i suoi destinatari in Stubwise: mittente, `to`, `cc`,
 * proprietari delle caselle — admin compresi, nessuna eccezione.
 */
export interface MailMessage {
  id: string;
  /** Il Message-ID RFC dell'email: chiave della proposta condivisa. */
  messageId: string;
  threadId: string;
  from: MailAddress;
  to: MailAddress[];
  /** `null` = nessuna copia nell'intestazione (non una lista vuota). */
  cc: MailAddress[] | null;
  subject: string;
  at: string;
  text: string;
  /** Il testo citato dei messaggi precedenti, piegato nella lettura. */
  quoted: string | null;
  /** L'originale HTML, mostrato in un frame isolato (immagini remote bloccate). */
  html: string | null;
  /** `as: "link"` solo per un file Google allegato da Stubwise come link (assente = copia). */
  attachments: { id: string; name: string; sizeBytes: number; as?: "link" }[];
  /** Le caselle che lo contengono. */
  mailboxPersonIds: string[];
  readByPersonIds: string[];
  /** `transcript` = l'email di Gemini con le note di una riunione. */
  kind: "email" | "transcript";
  /** Un messaggio di contesto della conversazione (non classificato da sé). */
  context: boolean;
  classification: MailClassification;
  /** Solo i messaggi scritti da Stubwise: lo stato dell'invio. */
  delivery?: { state: "sending" | "sent" | "failed"; sentById: string; error?: string };
}

/**
 * Le note di una riunione registrata (email di Gemini): il Google Doc letto
 * con l'account di chi l'ha ricevuta, l'evento collegato (link Meet e
 * orario) e il riassunto generato. Riassunto e trascrizione li vedono solo i
 * partecipanti dell'evento.
 */
export interface MeetingTranscript {
  /** L'id della riga `MailMessage` dell'email di Gemini. */
  messageId: string;
  eventId: string | null;
  docTitle: string;
  doc: "reading" | "ready" | "unreachable";
  transcript: string;
  summary: string | null;
}

export type MailProposalSource = "email" | "transcript" | "calendar";

/**
 * Una proposta nata dalla posta o dal calendario: una per email (Message-ID)
 * e progetto, condivisa fra i destinatari membri del progetto. Chi decide
 * per primo la chiude per tutti.
 */
export interface MailProposal {
  id: string;
  source: MailProposalSource;
  /** Il Message-ID RFC (email, trascrizione) o l'id dell'evento (calendario). */
  sourceId: string;
  projectId: string;
  actions: ProposedAction[];
  /** L'estratto che Stubwise ha letto: è ciò che vede chi la riceve passata. */
  excerpt: string;
  createdAt: string;
  status: "open" | "confirmed" | "ignored" | "handed" | "failed";
  decidedById: string | null;
  decidedAt: string | null;
  resultCodes: string[];
  error: string | null;
  handedAt: string | null;
  /** Chi l'ha passata al progetto: resta anche dopo la decisione di chi ha il permesso. */
  handedById: string | null;
  /** Confermata solo in parte: gli indici delle azioni eseguite. */
  confirmedActions?: number[];
  /** Chi ha scelto il progetto di un'email incerta (`chooseProject` risolta). */
  projectChosenById?: string;
}

/** I filtri delle proposte della posta: di un'email (Message-ID) e per stato. */
export interface MailProposalFilters {
  sourceId?: string;
  status?: MailProposal["status"];
}

/**
 * Una proposta della posta come la vede chi guarda: se può confermarla (il
 * permesso di ogni azione nel progetto) o solo passarla al progetto, gli
 * incaricati che non sono nel progetto, e chi l'ha decisa (o passata).
 */
export interface MailProposalView {
  proposal: MailProposal;
  canConfirm: boolean;
  canHand: boolean;
  /**
   * Chi guarda può spostarla su un altro progetto di cui è membro
   * (`reassignMailProposal`): aperta, da un'email che riceve, con sole azioni
   * portabili, e almeno un altro progetto dove spostarla.
   */
  canReassign: boolean;
  outsiders: { personId: string; name: string }[];
  decidedBy: { personId: string; name: string } | null;
  /**
   * Gli altri che la condividono («Also for …»): le persone nelle intestazioni
   * dell'email (mittente, `to`, `cc` — mai i ccn) o fra i partecipanti
   * dell'evento che vedono questa proposta, tranne chi guarda. Vuoto per chi
   * non è destinatario (una proposta passata letta per il solo estratto).
   */
  sharedWith: { personId: string; name: string }[];
  /**
   * Da dove viene, per la riga d'origine di «Da decidere» (shape home.md §8):
   * solo se chi guarda vede l'origine (l'email con `canSeeMessage`, la
   * riunione con `canReadEvent`); `null` altrimenti — una proposta passata
   * letta per il solo estratto. La calcola `listMailDecisions`.
   */
  origin?: MailProposalOrigin | null;
}

/** L'origine di una proposta della posta, come la vede chi guarda. */
export type MailProposalOrigin =
  | { kind: "email"; threadId: string; from: string; subject: string }
  | { kind: "meeting"; eventId: string | null; threadId: string; title: string; at: string }
  | { kind: "calendar"; eventId: string; title: string; startsAt: string; allDay: boolean };

/** Una bozza, per persona e conversazione (`threadId: null` = email nuova). */
export interface MailDraft {
  id: string;
  personId: string;
  threadId: string | null;
  mode: "new" | "reply" | "replyAll" | "forward";
  replyToMessageId: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  body: string;
  /**
   * `as`: un file del Drive di Stubwise (o dal disco, o inoltrato) parte come
   * COPIA; un file Google come LINK (pesa 0: Gmail non lo allega, e per
   * aprirlo serve l'accesso su Google).
   */
  attachments: MailDraftAttachment[];
  /**
   * Rispondi: il messaggio a cui si risponde va citato sotto (assente =
   * sì, shape mail-compose [A 4]); `false` l'ha tolto chi scrive. Inoltra
   * lo cita sempre; l'email nuova non cita nulla.
   */
  quote?: boolean;
  /**
   * Un'email nuova che non è «la» nuova email di chi scrive: la bozza di
   * «Scrivigli anche per email» di una conversazione di Support
   * (`support-<PRJ>-S<n>`, R-K14), con un posto suo accanto a quello della
   * nuova email, che così non si sovrascrive. Assente = la nuova email.
   */
  slot?: string;
  updatedAt: string;
}

export interface MailDraftAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  driveFileId: string | null;
  as: "copy" | "link";
}

/**
 * Un destinatario suggerito mentre si scrive: una persona del team
 * (`team`) o un indirizzo visto nei messaggi che chi scrive vede (`mail`).
 */
export interface MailRecipientSuggestion extends MailAddress {
  group: "team" | "mail";
}

/**
 * Un invio partito: `messageId` è l'id della RIGA del messaggio (non il
 * Message-ID RFC); fino a `undoUntil` (5 s dopo «Invia») si può annullare.
 */
export interface MailSendResult {
  messageId: string;
  /** La conversazione del messaggio (per un'email nuova, quella appena nata). */
  threadId: string;
  /** L'email nuova partita da uno slot (R-K14): «Undo» chiude quella casella. */
  slot?: string;
  undoUntil: string;
}

/**
 * Una bozza tornata («Annulla», «Elimina» un invio fallito). Se nella
 * conversazione ce n'era già una, le due si uniscono: gli allegati che non
 * stanno più nei limiti (10 file, 25 MB) restano fuori e sono elencati qui.
 */
export interface MailDraftRestore {
  draft: MailDraft;
  droppedAttachments: MailDraftAttachment[];
}

/** I filtri dell'elenco della Posta (tutti facoltativi). */
export interface MailThreadFilters {
  /** L'indirizzo di una delle mie caselle: solo la posta che contiene. */
  mailbox?: string;
  importance?: MailImportance;
  projectId?: string;
  q?: string;
}

/**
 * Una conversazione nell'elenco, calcolata sui soli messaggi che chi guarda
 * vede: l'importanza più alta, la scadenza più vicina, i progetti che può
 * vedere, quanti messaggi non ha letto e quante proposte aperte lo aspettano.
 */
export interface MailThreadRow {
  threadId: string;
  /** L'oggetto del primo messaggio. */
  subject: string;
  lastAt: string;
  /** I mittenti, in ordine di primo messaggio. */
  participants: MailAddress[];
  projectIds: string[];
  /** `null` finché nessun messaggio è classificato. */
  importance: MailImportance | null;
  dueDate: string | null;
  /** Quanti messaggi chi guarda non ha ancora letto. */
  unread: number;
  openProposals: number;
  /** Almeno un messaggio è in analisi. */
  analysing: boolean;
  /** L'analisi di almeno un messaggio è fallita («Riproponi»). */
  failed: boolean;
  /** Quanti messaggi vede chi guarda. */
  messages: number;
  /** Almeno un messaggio ha allegati. */
  attachments: boolean;
  /** L'inizio del testo dell'ultimo messaggio, su una riga. */
  snippet: string;
}

/**
 * Un messaggio come lo legge chi guarda: chi altro l'ha letto non si dice
 * (`read` è solo il suo), né quali caselle lo contengono (rivelerebbe i
 * destinatari in ccn), e la classificazione nomina solo i progetti che può
 * vedere.
 */
export interface MailMessageView extends Omit<MailMessage, "readByPersonIds" | "mailboxPersonIds"> {
  read: boolean;
  /** Solo un'email di Gemini (`kind: "transcript"`): le note della riunione. */
  meeting?: MeetingNote;
}

/**
 * Le note di una riunione come le vede un destinatario dell'email di Gemini.
 * `visible`: è un partecipante (`canSeeTranscript`), quindi vede riassunto e
 * trascrizione (col documento letto); altrimenti restano `null` e la Posta
 * dice che li vede solo chi c'era. `event` c'è solo se chi guarda vede
 * l'evento. A chi non c'era nemmeno il Google Doc: `docTitle` e `doc` sono
 * `null` (resta ciò che dice l'email).
 */
export interface MeetingNote {
  docTitle: string | null;
  doc: MeetingTranscript["doc"] | null;
  visible: boolean;
  summary: string | null;
  transcript: string | null;
  event: { id: string; title: string; startsAt: string; endsAt: string; people: number } | null;
}

/** Una conversazione aperta: i messaggi che chi guarda vede, dal più vecchio. */
export interface MailThreadDetail {
  threadId: string;
  subject: string;
  messages: MailMessageView[];
}

/**
 * Una mia casella con il suo allineamento: `stale` oltre 5 minuti
 * dall'ultimo, `expired` se l'account Google è scaduto («Ricollega»).
 */
export interface MailboxView extends Mailbox {
  stale: boolean;
  expired: boolean;
}

/** Un messaggio trovato dalla ricerca (⌘K). */
export interface MailSearchHit {
  /** L'id della riga del messaggio. */
  id: string;
  threadId: string;
  subject: string;
  from: MailAddress;
  at: string;
  /** L'inizio del testo, per la riga del risultato. */
  snippet: string;
}

// --- Calendario (area 6) ------------------------------------------------------

/** La risposta di un invitato, coi valori di Google. */
export type Rsvp = "accepted" | "declined" | "tentative" | "needsAction";

export interface CalendarAttendee {
  email: string;
  name: string;
  personId: string | null;
  response: Rsvp;
  organizer: boolean;
  /** La nota che accompagna la risposta («Arrivo 10 minuti in ritardo»). */
  note?: string;
}

/**
 * Un evento come lo legge Google: una riga per occorrenza (una serie ha una
 * riga per data, con `seriesId`). Con orario: istanti; «tutto il giorno»:
 * mezzanotte UTC della data, `endsAt` esclusiva (la doppia regola dei fusi
 * di `calendar-grid` di `@stubwise/shared`).
 */
export interface CalendarEvent {
  id: string;
  /** I calendari (persone con l'account Google) che lo contengono. */
  calendarPersonIds: string[];
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string | null;
  meetUrl: string | null;
  attendees: CalendarAttendee[];
  reminders: { minutes: number; method: "popup" | "email" }[] | "default";
  seriesId: string | null;
  projectId: string | null;
  /** Chi ha deciso il progetto: il modello o una persona (la correzione vale per tutti). */
  projectBy: "model" | "manual" | null;
  /** Una scrittura verso Google: in corso, confermata, rifiutata. */
  save?: { state: "saving" | "saved" | "failed"; error?: string };
}

/** Una serie ricorrente e la sua configurazione (spenta di default). */
export interface CalendarSeries {
  id: string;
  title: string;
  /** La regola di Google (`RRULE:…`): la UI la dice a parole con `parseRecurrence`. */
  rule: string;
  projectId: string | null;
  enabled: boolean;
  action: "milestone" | "request" | "remind";
  leadDays: number;
  auto: boolean;
}

/** L'allineamento del calendario di una persona con Google. */
export interface CalendarSync {
  personId: string;
  email: string;
  syncedAt: string;
  sync: "ok" | "syncing" | "failed";
}

/** Il mio calendario col suo allineamento: `stale` oltre 5 minuti, `expired` con l'account scaduto. */
export interface CalendarSyncView extends CalendarSync {
  stale: boolean;
  expired: boolean;
}

/**
 * Un evento come lo vede chi guarda: la sua risposta, se ne è
 * l'organizzatore, in quale dei suoi calendari sta; il progetto solo se lo
 * vede (altrimenti «Nessun progetto»).
 */
export interface CalendarEventView extends CalendarEvent {
  myResponse: Rsvp | null;
  isOrganizer: boolean;
  /** Il mio calendario che lo contiene; `null` se ci sono solo come invitato senza account. */
  calendarEmail: string | null;
  /**
   * Ha la scheda di preparazione per chi guarda (`getMeetingPrep` non è
   * `null`): non ancora finito, con un progetto di cui è membro. Lo calcola
   * il livello dati; il segno sui blocchi e il dettaglio lo leggono.
   */
  hasPrep: boolean;
}

/** Una serie come la vede chi guarda: le date dentro la finestra letta e la prossima. */
export interface CalendarSeriesView extends CalendarSeries {
  occurrencesInWindow: number;
  nextAt: string | null;
}

/**
 * Il dettaglio di un evento, con la sua serie. Riassunto e scheda di
 * preparazione sono letture a sé (`getMeetingSummary`, `getMeetingPrep`).
 */
export interface CalendarEventDetail extends CalendarEventView {
  series: CalendarSeriesView | null;
}

/**
 * Libero/occupato di una persona: solo gli intervalli, mai un titolo.
 * `not_connected`/`expired`: il suo calendario non si legge.
 */
export interface FreeBusy {
  personId: string;
  availability: "connected" | "not_connected" | "expired";
  busy: { startsAt: string; endsAt: string }[];
}

/** Un invitato da aggiungere: una persona del team o un indirizzo. */
export type CalendarGuestInput = { personId: string } | { email: string; name?: string };

export interface CalendarEventInput {
  title: string;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
  guests?: CalendarGuestInput[];
  /** «Aggiungi Google Meet»: il link nasce al salvataggio. */
  addMeet?: boolean;
  description?: string | null;
  location?: string | null;
  /** Uno dei miei progetti, o nessuno. */
  projectId?: string | null;
  reminders?: CalendarEvent["reminders"];
}

/** Cosa cambia «Modifica» (gli orari li cambia `moveEvent`, il progetto `setEventProject`). */
export type CalendarEventPatch = Partial<
  Pick<
    CalendarEventInput,
    "title" | "guests" | "addMeet" | "description" | "location" | "reminders"
  >
>;

/** «Solo questo» o «tutta la serie». */
export type CalendarScope = "one" | "series";

export type CalendarSeriesPatch = Partial<
  Pick<CalendarSeries, "projectId" | "enabled" | "action" | "leadDays" | "auto">
>;

// --- Automations (area 7) ----------------------------------------------------

// Un flusso è un documento dichiarativo ad albero (JSON tipato): lo valida
// una funzione pura e lo interpreta un motore puro (`domain/automations`).
// Niente salti all'indietro: i cicli sono solo `forEach` e `repeatUntil`.
// Nei testi dei passi i dati si citano con `{{chiave}}` (es. `{{cliente.nome}}`).
//
// Convenzioni del motore (decisioni del controller, area 7):
// - R-J2 — un `wait` con `replyTo` scrive, a OGNI attesa, `risposta.arrivata`
//   e `risposta.testo`: con la risposta `true` e il testo, scaduto `maxDays`
//   `false` e `""`. Così una verifica successiva non rilegge mai una
//   risposta vecchia. I campi stanno in `domain/automations/triggerFields.ts`
//   (`WAIT_REPLY_FIELDS`), con quelli degli inizi interni.
// - R-J3 — le chiavi dei campi di Claude valgono per tutto il flusso, e un
//   passo successivo può ridichiararle (vince il valore più recente). Dentro
//   un `forEach`, `as` fa da prefisso alle chiavi relative dell'elemento:
//   `as: "task"` su un elenco con `of: [{ key: "titolo" }]` → `task.titolo`.
// - R-J4 — `repeatUntil` controlla `until` PRIMA di ogni giro (un «while»,
//   non un «do-while»): se è già vera, zero giri.
// - R-J5 — un percorso (`RunLogEntry.path`, `AutomationRun.cursor`) è una
//   sequenza di segmenti separati da `/`: l'indice del passo nella sua
//   lista; `then`/`else` dopo una `condition`; il nome dell'uscita dopo un
//   passo `claude`; `forEach[i]` (giro i, da 0) dopo un `forEach`;
//   `repeat[i]` o `onLimit` dopo un `repeatUntil`; `trigger` da solo per
//   l'inizio. Esempi: `"0"`; `"2/forEach[1]/0/else/0/then/0"`;
//   `"3/then/0/mancano informazioni/0"`; `"2/repeat[0]/1"`;
//   `"2/onLimit/0"`; `"trigger"`. In `validateFlow` e `availableFields` i
//   giri si scrivono `forEach[0]`/`repeat[0]` (vale per ogni giro).
// - R-J6 — il tipo di campo `boolean` (es. `risposta.arrivata`): nelle
//   condizioni si confronta con `is`/`is_not` e il valore `true`/`false`.

/** `boolean` (R-J6): nelle condizioni si confronta con `is`/`is_not` e un valore `true`/`false`. */
export type FieldType =
  | "text"
  | "number"
  | "date"
  | "email"
  | "person"
  | "list"
  | "file"
  | "boolean";

/** Un dato che i passi possono usare: dell'inizio, o prodotto da un passo precedente. */
export interface DataField {
  /** Es. "trattativa.cliente". */
  key: string;
  label: string;
  type: FieldType;
  /** Per un elenco: i campi di ogni elemento (chiavi relative all'elemento). */
  of?: DataField[];
}

export type AutomationTrigger =
  | { kind: "source"; sourceId: string; event: "deal_won" | "webhook" }
  | {
      kind: "stubwise";
      event:
        | "task_created"
        | "task_closed"
        | "request_created"
        | "milestone_reached"
        | "mail_received";
      filter?: Condition;
    }
  /** `rule`: una RRULE semplice, es. "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9". */
  | { kind: "schedule"; rule: string }
  | { kind: "manual" };

export type Operand = { ref: string } | { value: string | number | boolean | null };

/** Un gruppo (`all`/`any`) o un confronto (`left op right`); niente espressioni libere. */
export interface Condition {
  all?: Condition[];
  any?: Condition[];
  left?: Operand;
  op?: "is" | "is_not" | "contains" | "empty" | "not_empty" | "gt" | "lt";
  right?: Operand;
}

/** «Parte da solo» o «Chiede approvazione a …» (persona, ruolo nel progetto, il proprietario). */
export type Approval =
  | { mode: "auto" }
  | { mode: "ask"; who: { personId: string } | { projectRole: string } | { owner: true } };

/** Il progetto del passo: quello dell'automazione, uno fisso, o dal cliente (tabella cliente → progetto). */
export type ProjectTarget =
  | { mode: "own" }
  | { mode: "fixed"; projectId: string }
  | { mode: "from_client"; clientRef: string };

/**
 * Una persona indicata da un passo: una persona scelta, il dato Persona
 * dell'evento o di un passo (`personRef`, una chiave, mai un modello né un
 * testo libero: si legge una volta sola durante l'esecuzione) o un ruolo nel
 * progetto del passo (la prima persona col ruolo, in ordine alfabetico).
 */
export type PersonTarget = { personId: string } | { personRef: string } | { projectRole: string };

export type Step =
  | {
      id: string;
      kind: "createTask";
      title: string;
      description: string;
      /** Una persona (scelta o dal dato Persona), un reparto (nessun incaricato), un ruolo nel progetto. */
      assignee: PersonTarget | { departmentId: string } | null;
      dueInDays: number | null;
      project: ProjectTarget;
      /** L'id di un passo `createMilestone` precedente. */
      milestoneRef: string | null;
      approval: Approval;
    }
  | {
      id: string;
      kind: "createMilestone";
      name: string;
      dueInDays: number | null;
      project: ProjectTarget;
      approval: Approval;
    }
  | {
      id: string;
      kind: "createRequest";
      title: string;
      description: string;
      project: ProjectTarget;
      approval: Approval;
    }
  | {
      id: string;
      kind: "sendEmail";
      /** Un modello, es. "{{cliente.email}}". */
      to: string;
      subject: string;
      body: string;
      attachRefs: string[];
      approval: Approval;
    }
  | { id: string; kind: "notify"; who: PersonTarget; text: string; approval: Approval }
  | { id: string; kind: "startAutomation"; automationId: string; approval: Approval }
  | {
      id: string;
      kind: "wait";
      /**
       * Un tempo, la risposta a un `sendEmail` (per id) o una task chiusa, col
       * massimo di giorni. `replyTo` scrive `risposta.arrivata`/`risposta.testo` (R-J2).
       */
      for:
        | { days: number }
        | { replyTo: string; maxDays: number }
        | { taskClosed: string; maxDays: number };
    }
  | {
      id: string;
      kind: "claude";
      instruction: string;
      inputs: string[];
      /** Le sole uscite ammesse (regola 2 dell'anti-obiettivo). */
      outcomes: string[];
      /** I soli campi che può compilare, col loro tipo; chiavi globali, ridichiarabili (R-J3). */
      fields: DataField[];
      /** I passi di ogni uscita; un'uscita senza ramo prosegue. */
      branches: Record<string, Step[]>;
    }
  | { id: string; kind: "condition"; when: Condition; then: Step[]; else: Step[] }
  /** `as` fa da prefisso alle chiavi relative dell'elemento (R-J3). */
  | { id: string; kind: "forEach"; list: string; as: string; steps: Step[] }
  | {
      id: string;
      kind: "repeatUntil";
      /** Controllata prima di ogni giro (R-J4). */
      until: Condition;
      /** Obbligatorio (≤ 10); finito, esce da `onLimit` («limite raggiunto»). */
      max: number;
      steps: Step[];
      onLimit: Step[];
    };

export interface AutomationFlow {
  trigger: AutomationTrigger;
  steps: Step[];
  /** Il titolo di ogni esecuzione, es. "Nuovo contratto – {{cliente.nome}}". */
  titleTemplate: string;
}

export interface AutomationVersion {
  n: number;
  flow: AutomationFlow;
  /** null = bozza. */
  publishedAt: string | null;
  publishedById: string | null;
  /**
   * Una bozza: chi l'ha salvata per ultimo, quando, e il numero del
   * salvataggio. Il costruttore salva dicendo quale `rev` ha letto; se
   * un'altra persona l'ha cambiata dopo, il salvataggio si ferma (`invalid:
   * stale`, shape builder [A 12]). Un numero e non l'ora: l'orologio del
   * prototipo è fisso.
   */
  savedAt?: string | null;
  savedById?: string | null;
  rev?: number | null;
  /**
   * R-J19: la revisione (`rev`, null per una mai salvata) provata fino in
   * fondo con una prova finita bene. Assente = mai provata. «Accendi» e
   * «Pubblica» dicono «non l'hai ancora provata» quando non coincide con
   * `rev`: ogni salvataggio dà un `rev` nuovo, quindi una modifica dopo la
   * prova la rende di nuovo non provata. È la sola traccia che una prova
   * lascia (shape automation-test [A 4], superata da R-J19).
   */
  testedRev?: number | null;
}

export interface Automation {
  id: string;
  /** `<PRJ>-A<n>` di progetto, `AUT-<n>` generale; mai riusati. */
  code: string;
  name: string;
  description: string;
  /** null = generale. */
  projectId: string | null;
  /** Chi l'ha accesa (o ne ha pubblicato l'ultima versione): gli effetti girano coi suoi permessi. */
  ownerId: string | null;
  status: "draft" | "active" | "paused";
  /** In ordine; l'ultima può essere una bozza. */
  versions: AutomationVersion[];
  createdAt: string;
  /** Chi l'ha creata (la riga di stato di una bozza: «created by»). */
  createdById?: string | null;
  /** Chi l'ha messa in pausa e quando (la riga di stato: «Paused by … on …»); si azzerano riaccendendo. */
  pausedById?: string | null;
  pausedAt?: string | null;
  /**
   * La casella da cui partono le email, scelta da chi l'ha accesa o
   * pubblicata fra le sue collegate (shape automations.md [A 12]). Assente:
   * la casella del proprietario.
   */
  mailbox?: string | null;
}

export type RunStatus =
  | "running"
  | "waiting_approval"
  | "waiting_event"
  | "waiting_project"
  | "suspended"
  | "done"
  | "failed"
  | "cancelled";

/** Una riga del registro di un'esecuzione (regola 3: tutto tracciato). */
/**
 * Una motivazione come codice e parametri (nomi propri, numeri, indirizzi):
 * l'interfaccia la traduce con `automations.reasons.<code>`, e nella prova
 * al condizionale. `reason` resta la prosa del registro.
 */
export interface ReasonCode {
  code: string;
  params?: Record<string, string | number>;
}

export interface RunLogEntry {
  at: string;
  stepId: string;
  /** Grammatica R-J5, es. "2/forEach[1]/0/then/0"; "trigger" per l'inizio. */
  path: string;
  kind: Step["kind"] | "trigger";
  /**
   * Gli esiti del motore, più quelli scritti dal livello dati sul passo al
   * cursore: `suspended` (pausa), `resumed` (riaccesa, `byId`), `cancelled`
   * («Annulla», `byId`), `retried` («Riprova», `byId`); «Salta» è `skipped`
   * con `byId`. Nessuno di questi conta come passo eseguito.
   */
  outcome:
    | "ok"
    | "skipped"
    | "failed"
    | "waiting"
    | "approved"
    | "rejected"
    | "limit"
    | "suspended"
    | "resumed"
    | "cancelled"
    | "retried";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  /** La motivazione (di Claude, o del fallimento): prosa per il registro, mai mostrata come tale. */
  reason: string | null;
  /** La motivazione come la mostra l'interfaccia, nella lingua di chi guarda (tutto tranne Claude). */
  why?: ReasonCode | null;
  /** Chi ha approvato, rifiutato, riprovato o saltato. */
  byId: string | null;
  /**
   * R-J16: solo nelle letture, per chi non è il proprietario — il testo della
   * risposta del cliente è stato tolto da questa riga (sta nella casella del
   * proprietario, shape [A 21]).
   */
  replyHidden?: boolean;
  /**
   * Le cose create dal passo (task, traguardo…) col loro codice. Nelle
   * letture (R-J12) una cosa in un progetto che chi guarda non vede ha
   * `code: ""`: né id né codice.
   */
  effects: { kind: string; code: string }[];
}

export interface AutomationRun {
  id: string;
  automationId: string;
  /** Numerata per automazione: «AUD-A1 #2». */
  n: number;
  /** La versione con cui è partita, e con cui finisce. */
  version: number;
  title: string;
  status: RunStatus;
  event: Record<string, unknown>;
  vars: Record<string, unknown>;
  /** Il percorso (R-J5) del passo corrente: per un'esecuzione in attesa, quello del passo che aspetta. */
  cursor: string | null;
  waitingUntil: string | null;
  /** Approvazione o «scegli il progetto» in attesa: chi decide e cosa vede. */
  pending: { approverIds: string[]; preview: Record<string, unknown> } | null;
  log: RunLogEntry[];
  startedAt: string;
  endedAt: string | null;
  /** Un codice macchina (es. `permission_lost`); la spiegazione sta nel `reason` del registro. */
  error: string | null;
  /** I progetti in cui ha agito (per le generali: dalla tabella cliente → progetto). */
  projectIds: string[];
  /**
   * Gli elementi dei `forEach` in corso, fissati all'ingresso
   * (`EngineState.loops`): la ripresa li rilegge da qui, mai dalle variabili.
   */
  loops?: Record<string, unknown[]>;
  /**
   * I clienti → progetti già risolti (`EngineState.projects`): un progetto
   * scelto a mano vale per tutti i passi dopo, anche dopo una ripresa.
   */
  projects?: Record<string, string>;
  /** L'esecuzione che l'ha avviata con «Avvia un'altra automazione» (catena di al massimo 3). */
  parentRunId?: string | null;
  /** Solo nelle letture (R-J13): l'evento è un'email che chi guarda non vede; la pagina lo dice. */
  mailHidden?: boolean;
  /** Da dove è partita (le ricorrenze contano solo le proprie, `dueSchedules`). */
  origin?: "manual" | "source" | "stubwise" | "schedule" | "automation";
  /** In `suspended` (pausa): lo stato a cui torna riaccendendo l'automazione. */
  suspendedFrom?: Exclude<RunStatus, "suspended" | "done" | "failed" | "cancelled">;
}

export interface AutomationSource {
  id: string;
  kind: "audin" | "hubspot" | "webhook";
  name: string;
  status: "connected" | "expired" | "disconnected";
  connectedById: string;
  /** Eventi di esempio: «Simula un evento» ne fa arrivare uno, la prova li offre. */
  sampleEvents: Record<string, unknown>[];
  /** I dati che i suoi eventi portano. */
  fields: DataField[];
  /** Un webhook in arrivo: l'indirizzo a cui si manda (finto nel prototipo). */
  address?: string;
  /** Quando è stata collegata, e chi l'ha ricollegata e quando (shape sources [A 5]). */
  connectedAt?: string;
  reconnectedById?: string | null;
  reconnectedAt?: string | null;
  /** Da quando è scaduta (stato `expired`). */
  expiredAt?: string | null;
}

/** Una riga della tabella cliente → progetto (gestita da chi ha `integrations.manage`). */
export interface ClientProjectLink {
  /** Es. il dominio o l'id del cliente. */
  clientKey: string;
  clientName: string;
  projectId: string;
  /** Chi l'ha aggiunta e quando (la colonna «Added by»). */
  addedById?: string;
  addedAt?: string;
}

// --- Rilasci, PR, ambienti, avvisi e Support (area 8a) -----------------------

/** Cosa fa Stubwise sulle PR dei colleghi di un repository. */
export type ColleaguePrMode = "analyze_and_fix" | "analyze_only" | "off";

/** L'analisi automatica di una PR, sulla testa `sha`. */
export interface PrAnalysis {
  sha: string;
  status: "running" | "done";
  summary: string;
  risk: "low" | "medium" | "high";
  issues: { title: string; file: string | null }[];
  at: string;
}

/**
 * Una correzione di Claude sul ramo di un collega: un commit sopra, push in
 * avanti. `discarded` = l'autore ha spinto nel frattempo (non conta nel
 * tetto); `stopped` = fermata prima del push.
 */
export interface PrAutoCorrection {
  id: string;
  trigger: "auto" | "person";
  /** Chi l'ha chiesta, se una persona. */
  byId: string | null;
  fromSha: string;
  state: "running" | "pushed" | "discarded" | "stopped";
  commitSha: string | null;
  why: string;
  at: string;
}

/** Una PR aperta, di Stubwise o di un collega (stessa forma per tutte). */
export interface OpenPullRequest extends PrRef {
  id: string;
  projectId: string;
  repositoryId: string;
  title: string;
  /** La persona collegata all'autore; `null` = identità git non collegata. */
  authorId: string | null;
  authorName: string;
  origin: "stubwise" | "colleague";
  taskId: string | null;
  branch: string;
  baseBranch: string;
  headSha: string;
  fromFork: boolean;
  branchProtected: boolean;
  /** «Solo analisi» acceso su questa PR, da chi e quando. */
  analysisOnly: { byId: string; at: string } | null;
  analysis: PrAnalysis | null;
  /** Solo colleghi: per quelle di Stubwise valgono le sessioni della task. */
  corrections: PrAutoCorrection[];
  checks: "passing" | "failing" | "pending" | "unreadable";
  mergeable: boolean;
  /**
   * Solo prototipo: la piattaforma rifiuterebbe il merge a Stubwise (permessi
   * del token o regole del ramo), l'errore `merge_forbidden` del web.
   */
  platformMergeForbidden?: boolean;
  state: "open" | "merged" | "closed";
  openedAt: string;
}

/** Una run di CI dopo il merge, letta dalla piattaforma (nel prototipo: del seme). */
export interface CiRun {
  id: string;
  name: string;
  status: "running" | "success" | "failed";
  url: string;
  failedStep: string | null;
  /** Il log (finto), anche lunghissimo; lo legge solo chi ha `repos.view`. */
  log: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** Un rilascio = un merge sul ramo di rilascio. Lo stato si DERIVA, non si salva. */
export interface Release {
  id: string;
  /** `<PRJ>-V<n>`, per progetto, mai riusato. */
  code: string;
  projectId: string;
  repositoryId: string;
  pr: PrRef;
  title: string;
  mergeSha: string;
  mergedAt: string;
  /** La persona che ha fatto il merge, se collegata; `null` = fuori da Stubwise e non collegata. */
  mergedById: string | null;
  mergedGitName: string;
  viaStubwise: boolean;
  runs: CiRun[];
  /** Quando l'agente dell'ambiente di produzione ha riportato il commit del merge. */
  seenInProductionAt: string | null;
  /** La task aperta da «Fai sistemare a Claude», se c'è. */
  fixTaskId: string | null;
}

/**
 * Su quale server gira una repository in un ambiente, e cosa ci riporta
 * l'agente (R-L2, maintainer 29 ott 2026): repository diverse dello stesso
 * progetto possono girare su server diversi.
 */
export interface EnvironmentServer {
  /**
   * La repository; `null` = tutto il progetto (un progetto senza repository,
   * o le repository che non hanno una riga propria).
   */
  repositoryId: string | null;
  /** Il server monitorato (`SRV-<n>`) il cui agente riporta il commit. */
  serverCode: string;
  /** Il commit che l'agente riporta per quella repository (o per il progetto). */
  reportedSha: string | null;
  reportedAt: string | null;
}

/**
 * Un ambiente del progetto: pura anagrafica, mai un bersaglio che Stubwise
 * esegue. Un solo ambiente di produzione per progetto; dentro, al più una
 * riga di `servers` per repository e al più una per tutto il progetto. Un
 * rilascio legge solo il server della SUA repository
 * (`environmentServerFor` in `domain/releases/environmentServer.ts`).
 */
export interface ProjectEnvironment {
  id: string;
  projectId: string;
  name: string;
  kind: "test" | "staging" | "production";
  url: string | null;
  servers: EnvironmentServer[];
}

// --- area 8b: server ----------------------------------------------------------

/** Le soglie di un server; `null` = soglia spenta. Di base quelle del web: 95/90/90, 5 minuti. */
export interface ServerThresholds {
  cpuPct: number | null;
  memPct: number | null;
  diskPct: number | null;
  sustainedMinutes: number;
}

/** Un controllo (come il monitor del web); stato e latenza sono quelli dell'ultimo campione. */
export interface ServerCheck {
  id: string;
  serverCode: string;
  name: string;
  type: "http" | "tcp" | "process" | "postgres" | "mysql";
  target: string;
  intervalSeconds: number;
  enabled: boolean;
  status: "up" | "down" | "unknown";
  latencyMs: number | null;
  lastError: string | null;
}

/**
 * Un campione di un controllo (R-L1): fa il grafico «Response time» del
 * controllo selezionato, con le fasce dei momenti in cui era giù. Giù: senza
 * latenza.
 */
export interface CheckSample {
  ts: string;
  status: "up" | "down";
  latencyMs: number | null;
}

/** Un servizio che l'agente vede: un container docker o un processo pm2. */
export interface ServerService {
  name: string;
  source: "docker" | "pm2";
  state: string;
  cpuPct: number | null;
  memBytes: number | null;
  restarts: number | null;
  image?: string;
}

export interface ServerDisk {
  mount: string;
  usedBytes: number;
  totalBytes: number;
}

/** Un campione dell'agente (ogni `sampleIntervalSeconds`); la rete in byte nell'intervallo. */
export interface MetricPoint {
  ts: string;
  cpuPct: number;
  memPct: number;
  diskPct: number;
  load1m: number;
  netRxBytes: number;
  netTxBytes: number;
}

/**
 * Un server monitorato, oggetto d'istanza: appartiene ai progetti
 * attraverso gli ambienti (`EnvironmentServer.serverCode`).
 */
export interface MonitoredServer {
  id: string;
  /** `SRV-<n>`, d'istanza, mai riusato. */
  code: string;
  name: string;
  hostname: string | null;
  status: "online" | "offline" | "never_connected";
  agentVersion: string | null;
  lastSeenAt: string | null;
  sampleIntervalSeconds: number;
  thresholds: ServerThresholds;
  services: ServerService[];
  disks: ServerDisk[];
  /** Dove si apre la diagnosi quando il server è in produzione di più progetti. */
  primaryProjectId: string | null;
  createdAt: string;
  /** Solo prototipo: se l'SSH risponde («Simula server irraggiungibile»). */
  sshReachable: boolean;
}

/** Perché un server è in difficoltà o non risponde. */
export type EpisodeReason =
  | { kind: "cpu" | "memory" | "disk"; valuePct: number; thresholdPct: number }
  | { kind: "check"; checkId: string }
  | { kind: "agent_silent"; since: string };

/** Un episodio: dall'allarme al rientro; un secondo allarme durante si aggiunge ai motivi. */
export interface ServerEpisode {
  id: string;
  serverCode: string;
  severity: "trouble" | "down";
  reasons: EpisodeReason[];
  startedAt: string;
  recoveredAt: string | null;
  analysisId: string | null;
}

/** L'analisi automatica di un episodio, in sola lettura: una sessione e, alla fine, una task. */
export interface ServerAnalysis {
  id: string;
  serverCode: string;
  episodeId: string;
  projectId: string;
  conversationId: string;
  outcome: "running" | "diagnosed" | "unreachable" | "timed_out";
  taskId: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** I due accessi SSH di un server: lettura (`stubwise-read`) e correzione (`stubwise-fix`). */
export type SshAccessKind = "read" | "fix";

/** Una chiave pubblica (`ssh-ed25519 AAAA… stubwise-read@SRV-1`); la privata sta solo in `data/servers/secrets.ts`. */
export interface SshPublicKey {
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

/** L'ultimo uso di un accesso: quando, e da quale analisi o task. */
export interface SshUse {
  at: string;
  ref: { kind: "analysis"; analysisId: string } | { kind: "task"; taskId: string };
}

/**
 * Lo stato degli accessi SSH di un server (nessuna riga = non collegato).
 * `pending`: chiavi generate e non ancora verificate — le prime (in attesa
 * del comando, `keys` nullo) o quelle di una rigenerazione (le vecchie in
 * `keys` restano valide finché la verifica delle nuove non riesce).
 */
export interface ServerSshAccess {
  serverCode: string;
  keys: Record<SshAccessKind, SshPublicKey> | null;
  pending: Record<SshAccessKind, SshPublicKey> | null;
  verification: {
    at: string;
    read: "ok" | "failed" | "writes";
    fix: "ok" | "failed";
    reason: string | null;
    /** La verifica era delle chiavi in `pending`. */
    ofPending: boolean;
  } | null;
  lastUse: Partial<Record<SshAccessKind, SshUse>>;
  revokedAt: string | null;
}

/** L'esito simulato della prossima «Verifica» di un accesso (solo prototipo). */
export type VerifyOutcome = "ok" | "read_fails" | "fix_fails" | "read_writes" | "unreachable";

/**
 * Un'iscrizione a un tipo di avviso in un progetto. Nessuna riga = il
 * default del catalogo; la storia serve a «spegnere vale solo per il
 * futuro»: l'ultima voce è lo stato di adesso.
 */
export interface AlertSubscription {
  personId: string;
  projectId: string;
  type: string;
  /**
   * Le voci in ordine di scrittura. `seq` c'è solo sulle voci scritte nella
   * sessione: l'ordine monotono condiviso con gli avvisi (R-K19), perché con
   * l'orologio fisso `at` non distingue un prima da un dopo.
   */
  history: { at: string; seq?: number; app: boolean; phone: boolean }[];
}

export interface SupportMessage {
  id: string;
  /** Il cliente, il triage di Claude o una persona del team. */
  from: "customer" | "triage" | "team";
  authorId: string | null;
  body: string;
  at: string;
}

/** Una conversazione di Support con un cliente: dal widget o dal server MCP (mai da un'email). */
export interface SupportConversation {
  id: string;
  /** `<PRJ>-S<n>`, per progetto, mai riusato. */
  code: string;
  projectId: string;
  channel: "widget" | "mcp";
  widgetId: string | null;
  customer: { name: string; email: string | null };
  messages: SupportMessage[];
  /** Il desiderio del cliente riscritto dal triage; `null` finché il triage non lo ha. */
  rewrittenWish: string | null;
  requestId: string | null;
  /** Il cliente se n'è andato prima della fine del triage. */
  leftAt: string | null;
  /**
   * Quando il cliente ha confermato il desiderio riscritto, a fine triage
   * («Confirmed by the customer, …»); `null` se non l'ha confermato (una
   * richiesta aperta dal team da una conversazione non conclusa).
   */
  confirmedAt: string | null;
  followerIds: string[];
  /** La bozza di risposta di Claude: la vede solo chi ha `support.reply`, non parte mai da sola. */
  claudeDraft: string | null;
}

/**
 * Un widget del customer service, coi campi del web (`widgetUpsertBodySchema`
 * di `@stubwise/shared`, shape support.md [A 16]). Spento non accetta
 * conversazioni nuove (lo fa il widget vero; qui basta il dato).
 */
export interface SupportWidget {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  /** Le fonti della documentazione: repository del progetto (`enabledRepositoryIds` sul web). */
  sourceRepositoryIds: string[];
  /** I siti da cui si può caricare. */
  origins: string[];
  title: string;
  welcomeMessage: string;
  /** Istruzioni in più per l'assistente; vuoto = nessuna. */
  instructions: string;
  /** `#rrggbb`. */
  accentColor: string;
  language: "it" | "en";
  /** Tetti giornalieri; `null` = il default d'istanza. */
  dailyMessageCap: number | null;
  dailyRequestCap: number | null;
  createdAt: string;
}
