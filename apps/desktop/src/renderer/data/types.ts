import type { InstancePermission, ProjectPermission } from "@stubwise/shared";
import type {
  CitationRef,
  CommitOfDay,
  Conversation,
  ConversationEvent,
  ConversationKind,
  DepartmentPermission,
  Milestone,
  Outcome,
} from "./model";

// I tipi del modello dell'area 2 stanno in `model.ts`; qui restano quelli
// dell'ossatura e del livello dati (chi guarda, ricerca, letture derivate).
export * from "./model";

/** Permessi di progetto che vivono solo nel prototipo (non nel registro condiviso). */
export type LocalProjectPermission = "planning.others";

/**
 * Permessi d'istanza che vivono solo nel prototipo (area 3): vedere le
 * conversazioni pubbliche con Claude e l'attività delle persone. Entrano nel
 * registro di `@stubwise/shared` quando si costruisce il backend.
 */
export type LocalInstancePermission = "claude.public.view" | "people.activity.view";

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
}

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
}

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
    | { id: string; available: true; title: string; events: ConversationEvent[] }
    | { id: string; available: false; title: null; events: [] }
    | null;
}

/**
 * Un oggetto citato nel flusso come lo legge chi guarda: codice, nome, stato
 * e persona per l'anteprima, e dove si apre. Un oggetto che chi guarda non
 * vede arriva con `visible: false` e nient'altro (né codice né nome).
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
}

/** Un risultato dei menu «#» (oggetti) e «@» (persone) della casella. */
export interface MentionResult {
  ref: CitationRef;
  code: string | null;
  label: string;
  /** Riga secondaria: il progetto, la sezione della pagina, il reparto. */
  detail: string | null;
  projectId: string | null;
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
