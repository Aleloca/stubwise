import type { InstancePermission, ProjectPermission } from "@stubwise/shared";
import type { Stall } from "../domain/stalled";
import type {
  Channel,
  ChatMessage,
  CitationRef,
  CommitOfDay,
  NotifyLevel,
  Conversation,
  ConversationEvent,
  ConversationKind,
  ConversationState,
  DepartmentPermission,
  DailyReport,
  DriveFile,
  DriveFileType,
  MailThreadRow,
  MeetingTranscript,
  Milestone,
  ModelUsage,
  Outcome,
  PrFact,
  PullRequestEvent,
  RunProvider,
  Task,
} from "./model";

// I tipi del modello dell'area 2 stanno in `model.ts`; qui restano quelli
// dell'ossatura e del livello dati (chi guarda, ricerca, letture derivate).
export * from "./model";

/**
 * Permessi di progetto che vivono solo nel prototipo (non nel registro
 * condiviso): pianificare per altri, dall'area 4 creare e gestire i
 * canali della Chat del progetto, dall'area 5 caricare nel Drive, gestirlo e
 * vederne lo storico delle aperture.
 */
export type LocalProjectPermission =
  | "planning.others"
  | "chat.channels.create"
  | "chat.channels.manage"
  | "drive.upload"
  | "drive.manage"
  | "drive.history";

/**
 * Permessi d'istanza che vivono solo nel prototipo: vedere le conversazioni
 * pubbliche con Claude e l'attività delle persone (area 3), creare e gestire
 * i canali generali della Chat (area 4). Entrano nel registro di
 * `@stubwise/shared` quando si costruisce il backend.
 */
export type LocalInstancePermission =
  | "claude.public.view"
  | "people.activity.view"
  | "chat.general.create"
  | "chat.general.manage";

export interface Viewer {
  personId: string;
  instancePermissions: (InstancePermission | LocalInstancePermission)[];
  projectPermissions: Record<string, (ProjectPermission | LocalProjectPermission)[]>;
  /** Permessi di reparto, per id del reparto. */
  departmentPermissions: Record<string, DepartmentPermission[]>;
}

export interface SearchResult {
  kind: "project" | "task" | "request" | "person";
  id: string;
  code?: string;
  label: string;
  route: string;
  /** Solo per le task: il reparto, per la striscia. */
  departmentId?: string;
}

/** Il polso di un progetto, per chi guarda. */
export interface ProjectPulse {
  projectId: string;
  /** Task aperte per famiglia. */
  open: { todo: number; active: number };
  stalled: number;
  waitingOnMe: boolean;
  claudeWorking: boolean;
  /** Il traguardo aperto con la data più vicina (anche se passata). */
  nextMilestone: Milestone | null;
}

/**
 * Un evento della cronologia di progetto (la Roadmap del web). Le voci che
 * non sono task né traguardi portano con sé ciò che serve a dirle, come
 * `projectTimelineEntrySchema`: il titolo della decisione, la prima riga del
 * brief, la sintesi del report.
 */
export type TimelineEvent =
  | { kind: "task_opened" | "task_closed"; at: string; taskId: string }
  | { kind: "milestone"; at: string; milestoneId: string }
  | { kind: "decision"; at: string; decisionId: string; title: string }
  | { kind: "brief"; at: string; briefId: string; headline: string }
  | { kind: "daily_report"; at: string; reportId: string; summary: string | null }
  | {
      kind: "pr_opened" | "pr_merged" | "pr_closed";
      at: string;
      prId: string;
      taskId: string;
      number: number;
    };

export type TimelineKind = TimelineEvent["kind"];

/** Una voce dell'attività del portafoglio: un evento di cronologia col suo progetto. */
export type PortfolioEvent = TimelineEvent & { projectId: string };

// --- area 3: letture delle conversazioni con Claude --------------------------

export interface ConversationFilter {
  /**
   * `live`: sessioni di lavoro non concluse; `mine`: le mie conversazioni
   * libere; `public`: le pubbliche degli altri; `finished`: sessioni concluse
   * (ultimi 14 giorni, salvo `includeOlder`).
   */
  scope: "live" | "mine" | "public" | "finished";
  projectId?: string;
  kind?: ConversationKind;
  outcome?: Outcome;
  taskId?: string;
  requestId?: string;
  includeOlder?: boolean;
  /** Solo in `mine`: vero = le archiviate (di base escluse). */
  archived?: boolean;
}

/** Una sessione di lavoro della task, quanto serve alla sezione «Claude» e alla storia del lavoro. */
export interface TaskRun {
  id: string;
  ownerId: string;
  createdAt: string;
  state: ConversationState;
  outcome: Outcome | null;
  /** Il flusso che chi guarda può leggere. */
  events: ConversationEvent[];
  /** L'account o la chiave API con cui gira (solo il nome); `null` se non si sa. */
  provider: RunProvider | null;
  /** Fallita: il riassunto del fallimento in una riga; altrimenti `null`. */
  failureSummary: string | null;
}

/** I fatti esterni di una PR, quanto ne legge la sezione (il ciclo si deriva: `prCycles`). */
export type PrFactView = Omit<PrFact, "taskId">;

/** Un report giornaliero con i commit della giornata arrivati dopo che è stato scritto. */
export interface DailyReportView extends DailyReport {
  newCommits: number;
}

/**
 * Il lavoro di Claude su una task come lo vede chi guarda: le sessioni di
 * lavoro (dalla più vecchia; l'ultima è «la» sessione della task), gli
 * eventi delle PR dalla piattaforma, e se il progetto ha un repository (solo
 * lì ci sono PR e correzioni).
 */
export interface TaskWork {
  runs: TaskRun[];
  pullRequests: PullRequestEvent[];
  software: boolean;
  /** Una PR ancora aperta: «Request changes» ha qualcosa da correggere. */
  openPr: boolean;
  /**
   * Le decisioni sui piani della task dal registro decisioni (`plan_review`),
   * con la loro data: la storia del lavoro dice quando un piano è stato
   * deciso solo se c'è la riga che lo dimostra.
   */
  planDecisions: PlanDecision[];
  /** Claude aspetta chi guarda: una domanda a cui può rispondere o un piano che può decidere. */
  waitsOnViewer: boolean;
  /** Ci sono sessioni di lavoro della task che chi guarda non vede (`repos.view`). */
  hiddenRuns: boolean;
  /** Cosa può fare chi guarda, deciso dal livello dati con le precondizioni delle scritture. */
  actions: Record<RunAction, ActionAvailability>;
  /** I fatti esterni delle PR (review, branch protetto, coda) e il tetto del progetto: il ciclo lo deriva `prCycles`. */
  prFacts: PrFactView[];
  correctionCap: number;
  /**
   * I consumi AI della task per modello, sommati su tutte le sue sessioni
   * (come il pannello del web: li vede chi vede la task). Vuoto: nessun consumo.
   */
  usage: ModelUsage[];
}

export interface PlanDecision {
  decidedById: string | null;
  decidedAt: string;
  /** Il testo del registro (un template nella lingua di chi ha deciso). */
  decision: string;
  /** L'esito: si confronta con il piano, mai leggendo il testo. */
  status: "approved" | "rejected";
}

export type RunAction = "start" | "relaunch" | "resume" | "requestChanges";

/**
 * `allowed`: si può fare; `forbidden`: lo stato lo consente ma chi guarda
 * non ha il permesso (la sezione dice chi può); `unavailable`: lo stato non
 * lo consente (nessuna azione, nessuna frase).
 */
export type ActionAvailability = "allowed" | "forbidden" | "unavailable";

/** Cosa sta facendo Claude adesso, per la riga dell'elenco. */
export type ConversationActivity =
  | { kind: "action"; label: string }
  | { kind: "question" }
  | { kind: "plan" }
  | null;

/** Una riga dell'elenco: la conversazione con il codice del suo oggetto e l'attività corrente. */
export interface ConversationRow extends Conversation {
  /** Il codice della task o della richiesta della sessione. */
  objectCode: string | null;
  activity: ConversationActivity;
  /**
   * Per chi non è l'autore: il seguito della pubblica è privato finché
   * l'autore non riconferma i progetti («Il resto della conversazione per ora
   * è privato»). Gli eventi arrivano solo fino a lì.
   */
  privateTail: boolean;
  /** Claude aspetta chi guarda: una domanda a cui può rispondere o un piano che può decidere. */
  waitsOnViewer: boolean;
}

type QuestionOfClaude = Extract<ConversationEvent, { type: "question" }>;

/**
 * Una domanda o un piano di Claude che aspetta chi guarda, per «Decide»
 * della Home: lo stesso evento della conversazione, con quanto serve a
 * dire di cosa si parla (task o richiesta, o la conversazione libera).
 */
export type ClaudeDecision = {
  /** La voce in «Decide» (e nell'«Undo»): `<conversazione>:<evento>`. */
  id: string;
  conversationId: string;
  conversationKind: ConversationKind;
  /** Il titolo della conversazione: lo dice la libera, che non ha oggetto. */
  title: string;
  ownerId: string;
  projectId: string | null;
  taskId: string | null;
  requestId: string | null;
  /** Il codice della task o della richiesta della sessione. */
  objectCode: string | null;
  /** Quando Claude ha chiesto. */
  at: string;
} & (
  | {
      kind: "question";
      questionId: string;
      text: string;
      options: QuestionOfClaude["options"];
    }
  | {
      kind: "plan";
      /** L'evento del piano: la decisione vale solo per questo piano. */
      planId: string;
      summary: string;
    }
);

/** Perché chi guarda non può scrivere. */
export type ReadOnlyReason =
  | "not_owner"
  | "archived"
  | "automatic"
  | "finished"
  | "not_interactive"
  | "no_permission";

/** Quello che chi guarda può fare in una conversazione: lo calcola il livello dati, mai la UI. */
export interface ConversationPermissions {
  isOwner: boolean;
  canWrite: boolean;
  canInterrupt: boolean;
  canAnswer: boolean;
  canDecidePlan: boolean;
  canPreApprovePlan: boolean;
  canRevokePlanApproval: boolean;
  /** Pubblica di un altro: scrivendo nasce una continuazione propria. */
  canContinue: boolean;
  /** Rinominare, archiviare, eliminare, renderla pubblica o privata (l'autore, solo libere). */
  canManage: boolean;
  /** Refine: «Close session» (`backlog.edit`, sessione aperta). */
  canClose: boolean;
  /**
   * Refine concluso: «Start new» (`backlog.edit`, e la richiesta si può
   * ancora rifinire — non trasformata, archiviata o fusa).
   */
  canStartNew: boolean;
  readOnlyReason: ReadOnlyReason | null;
}

export interface ConversationDetail extends ConversationRow, ConversationPermissions {
  /** Il flusso com'è adesso (proposte scadute già `expired`); dal vivo arriva dallo stream. */
  events: ConversationEvent[];
  planPreApproved: boolean;
  /**
   * La pubblica da cui continua, letta dal vivo (non copiata): titolo e
   * flusso visibile da mostrare in sola lettura in testa. Se l'originale non
   * è più visibile (privata, eliminata, permesso tolto) `available` è falso,
   * senza titolo né eventi, e la continuazione resta utilizzabile.
   */
  continuesFrom:
    | {
        id: string;
        available: true;
        title: string;
        /** Chi l'ha aperta («Continues from … · Giulia Ferri»). */
        ownerId: string;
        events: ConversationEvent[];
      }
    | { id: string; available: false; title: null; ownerId: null; events: [] }
    | null;
}

/**
 * Un oggetto citato nel flusso come lo legge chi guarda: codice, nome, stato
 * e persona per l'anteprima, e dove si apre. Un oggetto che chi guarda non
 * vede arriva con `visible: false`: al più il codice (task, richiesta,
 * progetto — R-E9), mai il nome né altro.
 */
export interface CitationView {
  kind: CitationRef["kind"];
  id: string;
  visible: boolean;
  /** Codice di catalogo (task, richiesta, progetto); per un file il repository. */
  code: string | null;
  /** Il nome leggibile: titolo, nome della persona, percorso del file o della pagina. */
  name: string | null;
  /** Il progetto dell'oggetto, per l'anteprima. */
  projectCode: string | null;
  /** Lo stato in parole (nome dello stato della task, stato della richiesta). */
  status: string | null;
  /** La persona dell'oggetto: l'assegnatario della task, o la persona citata. */
  personId: string | null;
  /** Dove si apre (route hash); `null` se non si apre (un file, una persona). */
  route: string | null;
  /**
   * Solo un file del Drive che chi guarda vede: quanto serve all'anteprima
   * del gettone (tipo, Google o caricato, riassunto, aperture degli ultimi
   * 90 giorni, non disponibile, nome del progetto). Un file che non vede
   * non lo porta mai.
   */
  drive?: {
    type: DriveFileType;
    google: boolean;
    summary: string | null;
    opens90d: number;
    unavailable: DriveFile["unavailable"];
    projectName: string;
  };
}

/** Un risultato dei menu «#» (oggetti) e «@» (persone) della casella. */
export interface MentionResult {
  ref: CitationRef;
  code: string | null;
  label: string;
  /** Riga secondaria: il progetto, la sezione della pagina, il reparto. */
  detail: string | null;
  projectId: string | null;
  /** Solo un file del Drive: il tipo, per la riga «codice · nome · tipo · progetto». */
  drive?: { type: DriveFileType; google: boolean };
}

/** Il risultato di «Rendi pubblica»: la prima volta chiede di confermare i progetti toccati. */
export type SetVisibilityResult =
  | { status: "needs_confirmation"; touchedProjects: { id: string; code: string; name: string }[] }
  | { status: "done"; conversation: Conversation };

/** La rassegna del giorno di una persona (o di un autore di commit non collegato). */
export interface PersonDayActivity {
  /** `null`: autore di commit non collegato a nessuna persona. */
  personId: string | null;
  name: string;
  departmentIds: string[];
  tasksClosed: { taskId: string; code: string; title: string; projectId: string; at: string }[];
  tasksMoved: {
    taskId: string;
    code: string;
    title: string;
    projectId: string;
    field: string;
    from: string | null;
    to: string | null;
    at: string;
  }[];
  comments: {
    id: string;
    taskId: string;
    code: string;
    projectId: string;
    body: string;
    at: string;
  }[];
  decisions: {
    id: string;
    source: "log" | "answer";
    projectId: string;
    taskId: string | null;
    title: string;
    at: string;
  }[];
  requestsCreated: {
    requestId: string;
    code: string;
    title: string;
    projectId: string;
    at: string;
  }[];
  commits: CommitOfDay[];
}

// --- Chat (area 4) -------------------------------------------------------------

/**
 * Cosa una persona può fare in un canale che vede: la regola del livello
 * dati (`channelPermissions`), che la UI legge invece di dedurla.
 */
export interface ChannelPermissions {
  /** Legge i messaggi (`canReadChannel`): un privato di cui non si è membri no, nemmeno chi gestisce. */
  canRead: boolean;
  isMember: boolean;
  /** Scrive: membro di un canale non archiviato. */
  canWrite: boolean;
  /** «Join channel»: aperto, non archiviato, non membro (mai il «general», che segue il progetto). */
  canJoin: boolean;
  /** Il «general» del progetto e un DM a due non si lasciano; un privato non resta senza membri. */
  canLeave: boolean;
  /** Nome e descrizione: il creatore o chi gestisce i canali di quell'ambito. */
  canEditInfo: boolean;
  /** L'argomento: qualunque membro (chi gestisce senza esserne membro no). */
  canEditTopic: boolean;
  /** Gli eventi pubblicati: solo canali di progetto, il creatore o chi gestisce. */
  canEditEvents: boolean;
  /** Aggiungere persone: in un privato il creatore o chi gestisce; in un aperto qualunque membro. */
  canInvite: boolean;
  /** Togliere persone: il creatore o chi gestisce (mai nel «general» né in un DM). */
  canRemove: boolean;
  /** Archiviare e ripristinare: il creatore o chi gestisce (mai il «general» né un DM). */
  canArchive: boolean;
  /** Eliminare: solo chi gestisce i canali dell'ambito, non il creatore (mai il «general» né un DM). */
  canDelete: boolean;
}

/** Un canale come lo legge una persona: i membri di adesso (il «general» segue il progetto). */
export interface ChannelView extends Channel, ChannelPermissions {
  notifyLevel: NotifyLevel;
}

/** Una riga della colonna della Chat (e di «Browse channels»). */
export interface ChannelRow extends ChannelView {
  /** Messaggi nuovi nel canale (0 se silenziato, non membro o non leggibile). */
  unread: number;
  /** Menzioni non lette (in un DM ogni messaggio conta come menzione). */
  mentions: number;
  /** L'ultimo messaggio leggibile; `null` se non si leggono i messaggi (nessuna attività rivelata). */
  lastActivityAt: string | null;
}

/** Il riassunto del thread sotto la radice: «4 replies · last by Elena». */
export interface ThreadSummary {
  replyCount: number;
  lastReplyAt: string;
  lastReplyById: string | null;
  /** Chi ha risposto (al più 3, dal più recente), per gli avatar impilati. */
  participantIds: string[];
  /** Ci sono risposte nuove per chi guarda (un thread che segue). */
  hasNews: boolean;
  /** Chi guarda segue il thread (ci ha scritto o è stato menzionato). */
  following: boolean;
  /** Una risposta di @Claude sta arrivando («Claude is replying…»). */
  claudeReplying: boolean;
}

/**
 * Un messaggio come lo legge una persona: eliminato = nessun testo, allegato,
 * citazione, reazione o domanda (in nessun posto). Le radici portano il
 * riassunto del thread.
 */
export interface ChatMessageView extends ChatMessage {
  thread: ThreadSummary | null;
  /** Di `asksReplyOf`, chi ha già risposto (nel thread o, per una radice, nel canale). */
  answeredIds: string[];
  /** Il messaggio nomina chi guarda (persona, reparto, @channel o domanda). */
  mentionsViewer: boolean;
  /**
   * Gli oggetti di `linkedCodes` («→ AUD-14»), derivati a lettura: la UI li
   * risolve come ogni citazione (codice + nome, R-E9 per chi non li vede).
   */
  linkedRefs: CitationRef[];
  /**
   * Solo una risposta di @Claude: i codici delle righe d'azione e delle
   * proposte che chi guarda NON vede. Il livello dati ne ha già tolto il
   * nome; la UI li mostra tenui (R-E9).
   */
  hiddenCodes?: string[];
}

/**
 * Una domanda di @Claude a chi l'ha chiamato in un thread della Chat
 * (R-G4): aperta finché lui non risponde (nel thread o in «Da decidere»: è
 * la stessa risposta), non ferma la risposta o non la elimina.
 */
export interface ChatClaudeQuestion {
  /** `chat-claude:<risposta>:<domanda>`. */
  id: string;
  channelId: string;
  /** La risposta di Claude che porta la domanda. */
  messageId: string;
  rootId: string;
  /** Il canale come lo legge chi guarda (`AUD · general`, i nomi del DM). */
  channelLabel: string;
  questionId: string;
  text: string;
  options: { label: string; consequence?: string; recommended?: boolean }[];
  createdAt: string;
}

/** Un membro di un canale. */
export interface ChannelMember {
  personId: string;
  isCreator: boolean;
}

/** Una pagina del flusso di un canale: i messaggi in ordine, dal più vecchio. */
export interface ChannelMessagesPage {
  messages: ChatMessageView[];
  /** Ci sono messaggi più vecchi (`before` = id del primo). */
  hasMore: boolean;
  /** Fin dove chi guarda aveva letto (la riga «New»); `null` se non è membro. */
  lastReadAt: string | null;
}

export interface ThreadView {
  channelId: string;
  root: ChatMessageView;
  replies: ChatMessageView[];
  /** Fin dove chi guarda aveva letto il thread (la riga «New replies»); `null` se non lo segue. */
  lastReadAt: string | null;
}

/** Una riga della vista «Threads»: un thread seguito con risposte nuove. */
export interface ThreadWithNews {
  channelId: string;
  root: ChatMessageView;
  /** Le ultime due risposte. */
  latestReplies: ChatMessageView[];
  newCount: number;
}

/** Un messaggio ritrovato (menzione, ricerca, link): con il canale e il messaggio prima. */
export interface ChatMessageHit {
  channelId: string;
  message: ChatMessageView;
  /** Il messaggio vivo precedente nello stesso flusso (contesto), se c'è. */
  context: ChatMessageView | null;
  /** Una risposta: la radice del suo thread («in a thread: …»), nello stesso canale. */
  root?: ChatMessageView | null;
}

export interface ChatSearchFilters {
  channelId?: string;
  authorId?: string;
  /** Date ISO (giorno) incluse. */
  from?: string;
  to?: string;
  withAttachments?: boolean;
  withCitations?: boolean;
  /** Esclude i messaggi di sistema. */
  peopleOnly?: boolean;
}

/** Una domanda rivolta a chi guarda in un messaggio della Chat: in «Da decidere» finché non risponde. */
export interface ChatQuestion {
  /** `chat:<messaggio>`. */
  id: string;
  channelId: string;
  messageId: string;
  /** La radice del thread in cui rispondere (il messaggio stesso se è nel canale). */
  rootId: string;
  /** Il canale come lo legge chi guarda (`AUD · general`, i nomi del DM). */
  channelLabel: string;
  askedById: string;
  text: string;
  createdAt: string;
}

export interface NewChannelInput {
  /** `null` = canale generale dell'azienda. */
  projectId: string | null;
  name: string;
  description?: string;
  visibility: "open" | "private";
  /** Solo un privato: chi invitare subito (chi crea c'è sempre). */
  memberIds?: string[];
}

export interface ChannelPatch {
  name?: string;
  description?: string;
  topic?: string;
}

export interface ChatMessageInput {
  text: string;
  attachments?: ChatMessage["attachments"];
  citations?: CitationRef[];
  /** La radice del thread in cui rispondere. */
  threadOf?: string;
  /** Solo una risposta: «Rispondi anche nel canale». */
  alsoInChannel?: boolean;
  /** «Ask for a reply»: chiede risposta alle persone menzionate anche senza «?». */
  asksReply?: boolean;
}

// --- riunioni registrate e scheda di preparazione (area 6) -----------------

/**
 * Il riassunto di una riunione registrata, per chi ha partecipato
 * (`canSeeTranscript`). `summary` e `transcript` ci sono solo col documento
 * letto (`doc: "ready"`); in lettura o non raggiungibile restano `null` e
 * `doc` lo dice. `email` è l'email di Gemini, solo se chi guarda la vede.
 */
export interface MeetingSummary {
  eventId: string;
  docTitle: string;
  doc: MeetingTranscript["doc"];
  summary: string | null;
  transcript: string | null;
  email: { threadId: string; sourceId: string; at: string } | null;
}

/**
 * Una cosa da fare nata da una riunione: una task o una richiesta creata
 * confermando una proposta della trascrizione, col suo stato di ADESSO.
 * `late`: aperta con la scadenza passata (l'«Overdue» delle righe di task,
 * `isOverdue`); `inProgress`: una task aperta nella famiglia «active».
 */
export interface MeetingTask {
  kind: "task" | "request";
  id: string;
  code: string;
  title: string;
  status: "open" | "done" | "late";
  inProgress: boolean;
  dueDate: string | null;
  departmentId: string | null;
}

/**
 * Una riunione passata del progetto, nella scheda. Chi non ha partecipato
 * ne vede titolo, data e cose da fare: `summary` e `doc` restano `null`
 * (nulla dice che un riassunto esista), e `canOpen` è falso se l'evento non
 * lo vede.
 */
export interface RecentMeeting {
  eventId: string;
  title: string;
  at: string;
  summary: string | null;
  doc: MeetingTranscript["doc"] | null;
  canOpen: boolean;
  tasks: MeetingTask[];
  /**
   * Le task ancora proposte dalle sue note e da decidere, che chi guarda
   * vede (`canSeeMailProposal`: chi c'era ed è membro): «4 proposed tasks ·
   * to decide», che porta al riassunto. Non sono ancora nate.
   */
  proposedTasks: number;
}

/**
 * La scheda di preparazione di un evento futuro o in corso, per un membro
 * del suo progetto. Lo stato riusa le letture dell'Overview: `pulse` è
 * `projectPulse`, `stalled` è `listStalled` sul progetto (dalla più
 * vecchia), `milestones` i traguardi aperti nell'ordine di «Where it stands».
 */
export interface MeetingPrep {
  eventId: string;
  projectId: string;
  pulse: ProjectPulse;
  /** Le conversazioni del progetto che chi guarda vede, dalla più recente: max 5. */
  recentMail: MailThreadRow[];
  /** Le riunioni passate del progetto, dalla più recente: max 3. */
  recentMeetings: RecentMeeting[];
  status: {
    inProgress: number;
    late: number;
    stalled: { task: Task; stall: Stall }[];
    /** Le prossime task aperte a scadenza (da oggi), max 3. */
    nextDueDates: Task[];
    /** I traguardi aperti, max 2. */
    milestones: Milestone[];
  };
}
