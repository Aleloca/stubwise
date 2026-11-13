import type { InstancePermission, ProjectPermission } from "@stubwise/shared";
import type { Stall } from "../domain/stalled";
import type {
  AiBlock,
  DataField,
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
  Utterance,
  ProductQuestionView,
} from "./model";

// I tipi del modello dell'area 2 stanno in `model.ts`; qui restano quelli
// dell'ossatura e del livello dati (chi guarda, ricerca, letture derivate).
export * from "./model";
// La classe calcolata delle azioni di Claude (area 10a): dalla foglia dei tipi.
export type { ActionClass, ClassReason, ClaudeBusyReason, ExecutedFailure } from "./claude/types";

/**
 * Permessi di progetto che vivono solo nel prototipo (non nel registro
 * condiviso): pianificare per altri, dall'area 4 creare e gestire i
 * canali della Chat del progetto, dall'area 7 gestire le automazioni del
 * progetto, dall'area 8b avviare la correzione di un server da una task
 * (`servers.operate`: nessun preset, solo concessioni persona × progetto).
 */
export type LocalProjectPermission =
  | "support.reply"
  | "servers.operate";

/**
 * Permessi d'istanza che vivono solo nel prototipo: vedere le conversazioni
 * pubbliche con Claude (area 3; l'attività delle persone, `people.activity.view`, è nel registro dall'integrazione area 3, fetta 3d), creare e gestire
 * i canali generali della Chat (area 4), gestire le automazioni generali
 * (area 7: stesso nome del permesso di progetto, vedi `can`), collegare,
 * verificare, rigenerare e revocare gli accessi SSH dei server (area 8b,
 * separato da `monitor.manage`), dall'area 9a vedere lo stato dell'istanza
 * e leggere il registro delle modifiche (entrambi del preset Admin, mai di
 * Claude). `departments.manage` è già nel registro (integrazione area 2). Entrano nel registro di `@stubwise/shared`
 * quando si costruisce il backend.
 */
export type LocalInstancePermission =
  | "servers.ssh.manage"
  | "instance.status.view"
  | "changelog.view";

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
  /**
   * Area 9b: lavoro di Claude nato ma fermo nel progetto (la coda in pausa,
   * il budget), col blocco che vale adesso; `null` se non ce n'è.
   */
  claudeWaiting?: AiBlock | null;
  /** Il traguardo aperto con la data più vicina (anche se passata). */
  nextMilestone: Milestone | null;
  /**
   * Build app: la lettura delle task aperte ha superato il tetto del server,
   * quindi i numeri sono «almeno» (la riga mette un «+»).
   */
  truncated?: boolean;
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
      /** Assente se il server non lo sa: la voce si mostra senza numero. */
      number?: number;
    }
  /**
   * Area 10a: una task eliminata, con codice e titolo di allora (la task non
   * c'è più) e chi l'ha eliminata; da `state.deletedTasks`.
   */
  | {
      kind: "task_deleted";
      at: string;
      taskId: string;
      code: string;
      title: string;
      byId: string;
      /**
       * Il nome di `byId`, a lettura per chi guarda (`listTimeline`,
       * `listPortfolioActivity`); `null` se non vede quella persona (R-G5).
       */
      byName?: string | null;
      /** Eliminata da Claude per `byId` (assente se a mano). */
      viaClaude?: boolean;
    };

export type TimelineKind = TimelineEvent["kind"];

/** Una voce dell'attività del portafoglio: un evento di cronologia col suo progetto. */
export type PortfolioEvent = TimelineEvent & { projectId: string };

/** Una pagina di cronologia o di attività, dalla più recente; `nextBefore` null = non c'è altra storia. */
export interface TimelinePage<E> {
  events: E[];
  nextBefore: string | null;
}

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
  /** Il modello con cui è partita (area 9b, «claude-haiku-5-5»); `null` per le sessioni di prima. */
  model: string | null;
  /** In attesa di un blocco d'istanza (area 9b: coda in pausa, budget); `null` se non aspetta. */
  waiting: AiBlock | null;
  /** Area 9b: è nata in attesa della coda; chi l'ha ripresa e quando (`null` se non ha aspettato). */
  queued: { resumedById: string | null; resumedAt: string | null } | null;
  /** Area 9b: il modello dell'esecuzione, se è partita; `null` altrimenti. */
  executionModel: string | null;
  /**
   * Area 9c: l'account che il progetto usava in esclusiva alla nascita
   * (`Conversation.requiredProvider`); `null` senza esclusività.
   */
  requiredProvider: { name: string } | null;
  /**
   * Area 9c: le skill della sessione scritte alla nascita
   * (`Conversation.skills`); `null` per una sessione nata prima del 9c.
   */
  skills: { plugin: string; skill: string }[] | null;
  /**
   * Build app (3b.1-bis): «Annulla il lavoro» chiesto su un lavoro in
   * esecuzione, il worker lo sta chiudendo. Assente nel prototipo.
   */
  cancelRequested?: boolean;
}

/** I fatti esterni di una PR, quanto ne legge la sezione (il ciclo si deriva: `prCycles`). */
export type PrFactView = Omit<PrFact, "taskId">;

/** Un report giornaliero con i commit della giornata arrivati dopo che è stato scritto. */
export interface DailyReportView extends DailyReport {
  newCommits: number;
  /** Build app: il report è in coda o si sta scrivendo (`GET /api/activity`). Assente nel prototipo. */
  pending?: boolean;
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
  /**
   * Area 9b: perché un lavoro nuovo di Claude non partirebbe adesso sulla
   * task (`aiBlockFor` del suo progetto) — il budget del mese esaurito (gli
   * avvii sono rifiutati: i bottoni spenti con la frase) o la coda in pausa
   * (gli avvii aspettano: i bottoni accesi con la frase). `null`: nessun blocco.
   */
  blocked: AiBlock | null;
}

export interface PlanDecision {
  decidedById: string | null;
  decidedAt: string;
  /** Il testo del registro (un template nella lingua di chi ha deciso). */
  decision: string;
  /** L'esito: si confronta con il piano, mai leggendo il testo. */
  status: "approved" | "rejected";
}

export type RunAction = "start" | "relaunch" | "resume" | "requestChanges" | "cancel";

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
export type ClaudeDecision = ConversationClaudeDecision | ProductQuestionDecision;

/**
 * Una domanda di Claude sulla doc di prodotto (11b, P17), per «Decide» di
 * chi la riceve (`productDocRecipients`) e ha `docs.edit` nel progetto. Si
 * risponde con `answerProductQuestion`; «Open a request» apre il riquadro
 * con la scheda di `productQuestionRequestDraft`.
 */
export type ProductQuestionDecision = {
  kind: "productQuestion";
  /** La voce in «Decide» (e nell'«Undo»): `product:<commento>`. */
  id: string;
  commentId: string;
  pageId: string;
  pageCode: string;
  pageTitle: string;
  projectId: string;
  /** Il codice del progetto, per gli indirizzi della pagina (la cronologia di «Open history»). */
  projectCode: string;
  /** Quando Claude ha chiesto. */
  at: string;
  /** La frase citata dal filo. */
  quote: string;
  /** La pagina aperta sul filo (`?comment=<id>`). */
  link: string;
} & Pick<
  ProductQuestionView,
  | "reason"
  | "forName"
  | "taskCode"
  | "source"
  | "applyMode"
  | "apply"
  | "recommended"
  | "options"
  | "applyBlocked"
>;

/** Una domanda o un piano di Claude in una conversazione, per «Decide». */
export type ConversationClaudeDecision = {
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
      /** Build app: il digest di questo piano, da rimandare decidendo (punto 13 della review). */
      planDigest?: string;
      summary: string;
      /**
       * Correzione di un server (area 8b): perché il piano non si può
       * approvare adesso; resta solo il rifiuto. `null` altrove.
       */
      blockedReason: ServerFixBlock | null;
      /** Il server di una correzione (`SRV-n`), `null` altrove. */
      serverCode: string | null;
    }
);

/** Perché chi guarda non può scrivere. */
export type ReadOnlyReason =
  | "not_owner"
  | "archived"
  | "automatic"
  | "finished"
  | "not_interactive"
  | "no_permission"
  /** Area 9b: la sessione è nata ma aspetta un blocco d'istanza (la coda in pausa). */
  | "waiting";

/** Quello che chi guarda può fare in una conversazione: lo calcola il livello dati, mai la UI. */
export interface ConversationPermissions {
  isOwner: boolean;
  canWrite: boolean;
  canInterrupt: boolean;
  canAnswer: boolean;
  /** Approvare (o rifiutare) il piano che aspetta. */
  canDecidePlan: boolean;
  /**
   * Rifiutare il piano che aspetta: come `canDecidePlan`, ma resta vero
   * quando l'approvazione è spenta (`planBlockedReason`). Il client lo legge.
   */
  canRejectPlan: boolean;
  canPreApprovePlan: boolean;
  canRevokePlanApproval: boolean;
  /** Pubblica di un altro: scrivendo nasce una continuazione propria. */
  canContinue: boolean;
  /** Rinominare, archiviare, eliminare, renderla pubblica o privata (l'autore, solo libere). */
  canManage: boolean;
  /**
   * Build app (fetta 5): renderla pubblica o privata, come dice il server
   * (`canPublish`); un server più vecchio non lo manda e non saprebbe farlo.
   * Assente nel prototipo, dove vale `canManage`.
   */
  canPublish?: boolean;
  /** Refine: «Close session» (`backlog.edit`, sessione aperta). */
  canClose: boolean;
  /**
   * Refine concluso: «Start new» (`backlog.edit`, e la richiesta si può
   * ancora rifinire — non trasformata, archiviata o fusa).
   */
  canStartNew: boolean;
  readOnlyReason: ReadOnlyReason | null;
  /**
   * Correzione di un server (area 8b): perché il piano non si può approvare
   * adesso, anche da chi ha `plans.approve` — il server non è più del
   * progetto, o l'accesso di correzione è revocato o non verificato. `null`
   * altrove, e per chi comunque non potrebbe decidere.
   */
  planBlockedReason: ServerFixBlock | null;
}

/** Perché una correzione di server non può eseguire comandi adesso (`serverFixBlock`). */
export type ServerFixBlock = "server_gone" | "fix_access_revoked" | "fix_access_unverified";

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
        /** Build app: il suo nome dal server (anche se chi guarda non la vede fra le persone). */
        ownerName?: string | null;
        events: ConversationEvent[];
      }
    | { id: string; available: false; title: null; ownerId: null; events: [] }
    | null;
  /**
   * Area 10a: lo stato di «Annulla» per ogni gruppo di azioni eseguite del
   * flusso (riga `executed` o scheda confermata con `groupId`), calcolato per
   * chi guarda. Facoltativo (P25): la pagina lo legge con `?? {}`.
   */
  undo?: Record<string /* groupId */, UndoView>;
  /**
   * Area 10a (M1 della revisione finale): per ogni scheda C aperta, la frase
   * all'infinito di ogni azione per il dialogo della riconferma («To add …» /
   * «Per aggiungere …»), `null` dove non c'è. Facoltativo (P25).
   */
  reauthPhrases?: Record<string /* proposalId */, (Utterance | null)[]>;
}

/** «Annulla» di un gruppo di azioni di Claude, come lo vede chi guarda (area 10a). */
export type UndoView =
  | { state: "available"; needsReauth: boolean }
  | { state: "undone"; byName: string; at: string }
  /** `byName`/`code` nulli se chi guarda non vede chi ha scritto o l'oggetto (R-G5). */
  | { state: "changed_after"; byName: string | null; code: string | null }
  | { state: "not_undoable" }
  /** L'inverso avvisa o fa partire un'automazione: aspetta la scheda aperta più sotto (I1). */
  | { state: "confirming" }
  /** Chi legge una pubblica altrui: la riga è chiusa. */
  | { state: "not_yours" };

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
  /** Solo una pagina di prodotto (area 11a): la riga dice «ACQ · Product», composta in lettura. */
  space?: "product";
}

/** Il risultato di «Rendi pubblica»: la prima volta chiede di confermare i progetti toccati. */
export type SetVisibilityResult =
  | {
      status: "needs_confirmation";
      touchedProjects: { id: string; code: string; name: string }[];
      /**
       * Build app (fetta 5, D1 del maintainer): chi legge vedrà anche ciò che
       * Claude ha letto per te, e il dialogo lo dice. Assente nel prototipo.
       */
      includesToolReads?: boolean;
      /** Build app: è la riconferma di un seguito privato (i progetti sono solo i nuovi). */
      reconfirm?: boolean;
    }
  | { status: "done"; conversation: Conversation };

/** La rassegna del giorno di una persona (o di un autore di commit non collegato). */
export interface PersonDayActivity {
  /** `null`: autore di commit non collegato a nessuna persona. */
  personId: string | null;
  name: string;
  /**
   * Solo senza persona, nella build app (area 3, 3e.2): l'email git
   * dell'autore (quella che «Link a person» collega) e lo username GitHub di
   * una noreply. Assenti nel prototipo e da un server più vecchio.
   */
  authorEmail?: string | null;
  authorUsername?: string | null;
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
    /** Area 10a: lo spostamento l'ha fatto Claude per questa persona. */
    viaClaude: boolean;
  }[];
  /** Area 10a: le task eliminate quel giorno, con codice e titolo di allora. */
  tasksDeleted: {
    taskId: string;
    code: string;
    title: string;
    projectId: string;
    at: string;
    viaClaude: boolean;
  }[];
  comments: {
    id: string;
    taskId: string;
    code: string;
    projectId: string;
    body: string;
    at: string;
    viaClaude: boolean;
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

/** L'esito del download di un allegato (Chat o task): mai il percorso scelto né l'URL. */
export type AttachmentDownloadResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "unauthenticated" | "not_found" | "failed" | "canceled" };
/** Il download di un allegato della Chat (fetta 4). */
export type ChatDownloadResult = AttachmentDownloadResult;

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
  /**
   * L'evento di CHI GUARDA; `null` per un invitato che non ce l'ha nel suo
   * calendario e arriva alla riunione per nota (Q-A = a).
   */
  eventId: string | null;
  /** La riunione (F5a): `getMeetingByNote`, «Open the meeting». */
  noteId?: string;
  docTitle: string;
  doc: MeetingTranscript["doc"];
  summary: string | null;
  transcript: string | null;
  /** `threadId` null: la conversazione non si apre (build app, senza la casella). */
  email: { threadId: string | null; sourceId: string; at: string } | null;
  /** Build app (F5): il link al Doc di Gemini («Open the transcript» apre Google Docs). */
  docUrl?: string | null;
  /** Build app (F5a): perché il Doc non si legge, o si legge solo in parte (`too_long`). */
  docReason?: import("./model").MeetingDocReason | null;
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

// --- Automations (area 7): le letture e la prova --------------------------------

// In `@stubwise/shared` (`automations/views.ts`): le rotte del server
// rispondono con questi tipi. Qui si ri-esportano, così nessun import cambia.
export type {
  AutomationRow,
  AutomationRunRow,
  AutomationDetail,
  AutomationRunDetail,
  AutomationSourceView,
  ClientLinkView,
  AutomationDecision,
  MyAutomationRun,
  ProjectAutomationRun,
  ProjectAutomationsView,
  AutomationOrigin,
  AutomationSearchResult,
  AutomationMeta,
  SimulationProject,
  SimulationTaskPreview,
  SimulationMilestonePreview,
  SimulationRequestPreview,
  SimulationEmailPreview,
  SimulationNotificationPreview,
  SimulationStartPreview,
  SimulationClaudePreview,
  SimulationExample,
  SimulationEffectPreview,
  SimulationWaiting,
  FilterCheck,
  SimulationView,
} from "@stubwise/shared";

/** «Replace example» di un webhook, prima di confermare (area 7). */
export interface WebhookExamplePreview {
  /** Il JSON non è valido: il messaggio del parser (riga e colonna, se le dice). */
  error: string | null;
  fields: DataField[];
  /** I campi di oggi che il nuovo esempio non ha e che un'automazione usa ([A 8]). */
  missing: { key: string; label: string; usedBy: string[] }[];
}
