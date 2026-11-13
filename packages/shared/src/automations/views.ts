import type {
  AutomationFlow,
  AutomationRun,
  Automation,
  AutomationSource,
  ClientProjectLink,
  DataField,
  RunStatus,
  RunLogEntry,
  Condition,
  Approval,
  ReasonCode,
  Step,
} from "./types.js";
import type { OwnerMailbox } from "./email.js";
import type { FlowIssue } from "./validate.js";

// Le letture delle Automations come le vede chi guarda (area 7): la riga
// dell'elenco, il dettaglio, le esecuzioni e la prova. Spostate dal prototipo
// (`data/types.ts`, che le ri-esporta) perché le rotte del server rispondano
// con questi tipi (forme confermate da 72 e 46, 13 nov 2026).

// --- Automations (area 7): le letture -------------------------------------------

/** Un'automazione come la legge chi guarda, con i permessi calcolati dal «server». */
export interface AutomationRow extends Automation {
  permissions: { manage: boolean };
  /** Le esecuzioni non finite (in corso, in attesa, sospese). */
  openRuns: number;
  /** Quelle ferme su un'approvazione, un evento o la scelta del progetto. */
  waitingRuns: number;
  lastRunAt: string | null;
  /** C'è una bozza: mai accesa, o della versione successiva a quella attiva. */
  hasDraft: boolean;
  /** Gli errori di configurazione dell'ultima versione (quella che si modifica). */
  configErrorCount: number;
  /** Quelli della versione pubblicata adesso (0 per una bozza mai accesa). */
  liveErrorCount: number;
}

/** Un'esecuzione con il suo codice («AUD-A1 #2») e la sua automazione. */
export interface AutomationRunRow extends AutomationRun {
  code: string;
  automationCode: string;
  automationName: string;
  /** Il progetto dell'automazione (null = generale). */
  automationProjectId: string | null;
  /** Il giro del passo in attesa (`cursor`), per `expectedRound`. Assente = 0. */
  round?: number;
}

export interface AutomationDetail {
  automation: AutomationRow;
  /** Gli errori dell'ultima versione (la bozza, se c'è): finché ci sono non si pubblica. */
  configErrors: FlowIssue[];
  /** Gli errori della versione pubblicata adesso (es. una sorgente scollegata). */
  liveErrors: FlowIssue[];
  /** Le esecuzioni, in corso in alto, poi dalla più recente (al massimo 20). */
  runs: AutomationRunRow[];
}

export interface AutomationRunDetail extends AutomationRunRow {
  /** Il flusso della versione con cui gira. */
  flow: AutomationFlow;
  /** Chi decide adesso (approvazione o progetto), risolto ora. */
  deciders: string[];
  /** Il proprietario dell'automazione adesso (anche per chi non vede l'automazione). */
  ownerId: string | null;
  permissions: {
    /** Annulla, Riprova, Salta, «Fai passare il tempo». */
    manage: boolean;
    approve: boolean;
    chooseProject: boolean;
    /**
     * F4: «Remember for <client>» accanto a «scegli il progetto» — chi decide
     * ha `integrations.manage` (calcolato dal server; senza, il server dà
     * 403). Assente da un server più vecchio: la casella non si mostra.
     */
    rememberClient?: boolean;
  };
  /** L'esecuzione che l'ha avviata e quelle avviate da lei, se chi guarda le vede. */
  parent: { id: string; code: string } | null;
  children: { id: string; code: string; status: RunStatus }[];
  /**
   * Il passo da approvare come anteprima condivisa (task, email…: la stessa
   * della prova e di «Da decidere»), risolta adesso; `null` se non ce n'è
   * una o se chi guarda non può leggerla (R-J13/R-J16).
   */
  pendingEffect: SimulationEffectPreview | null;
  /**
   * Un input di chi guarda (decisione, annulla, riprova, salta) è in coda e il
   * worker non l'ha ancora applicato: la pagina dice «in corso» e non offre
   * di decidere di nuovo. Assente = no (oggi lo sa solo il client).
   */
  inputQueued?: boolean;
}

export interface AutomationSourceView extends AutomationSource {
  permissions: { manage: boolean };
  /**
   * Area 7, F4 (F4-1 = a): l'automazione accesa o in pausa che parte da
   * questa sorgente. `null`: nessuna, o una che chi guarda non vede (R-G5:
   * allora `usedByHidden` è vero). Assente da un server più vecchio.
   */
  usedBy?: { code: string; name: string } | null;
  usedByHidden?: boolean;
}

/**
 * Un webhook appena creato o rigenerato (F4): l'INDIRIZZO intero, col segreto,
 * esce solo qui — poi il server ne tiene l'hash e non lo ridà più.
 */
export interface WebhookSourceCreated {
  source: AutomationSourceView;
  address: string;
}

/** Un evento recente di una sorgente (F4-5, F4-6: solo a chi ha `integrations.manage`). */
export interface AutomationSourceEvent {
  id: string;
  receivedAt: string;
  status: "accepted" | "duplicate" | "rejected";
  /** Per un rifiutato: `json` (non è un oggetto JSON) o `<campo>: <tipo atteso>`. */
  reason: string | null;
  /** Il corpo com'è arrivato (null se non era JSON). */
  payload: unknown;
}

/** «Replace example» di un webhook, prima di confermare (F4, come il prototipo). */
export interface WebhookExamplePreview {
  /** Il JSON non è valido: il messaggio del parser. */
  error: string | null;
  fields: DataField[];
  /** I campi di oggi che il nuovo esempio non ha e che un'automazione usa ([A 8]). */
  missing: { key: string; label: string; usedBy: string[] }[];
}

/** «From recent events»: un cliente arrivato da un'esecuzione ferma su «scegli il progetto», senza riga in tabella. */
export interface ClientSuggestion {
  clientKey: string;
  clientName: string;
}

/** Una riga della tabella cliente → progetto: un progetto che chi guarda non vede resta senza id. */
export interface ClientLinkView extends ClientProjectLink {
  projectVisible: boolean;
}

/** Una decisione in «Da decidere»: un passo da approvare o il progetto da scegliere. */
export interface AutomationDecision {
  kind: "approval" | "project";
  runId: string;
  code: string;
  title: string;
  automationId: string;
  automationName: string;
  projectId: string | null;
  stepKind: Step["kind"];
  preview: Record<string, unknown>;
  /** Da quando aspetta. */
  since: string;
  /** Il passo che aspetta (R-J5): la decisione vale solo per lui. */
  cursor: string;
  /**
   * Il giro del passo che aspetta (dentro «ripeti finché», dalla F2): con
   * `cursor` è il passo su cui si decide (`expectedRound`). Assente = 0.
   */
  round?: number;
  /** Il codice dell'automazione e il numero dell'esecuzione («AUD-A1», 12). */
  automationCode: string;
  n: number;
  /** Chi decide vede l'automazione: il link al suo dettaglio c'è solo allora. */
  automationVisible: boolean;
  /** «Scegli il progetto»: il cliente letto dall'evento, se c'è. */
  clientName: string;
  /** F4: «Remember for <client>» si può offrire (chi decide ha `integrations.manage`). Assente: no. */
  rememberClient?: boolean;
  /** L'anteprima condivisa del passo da approvare (vedi `AutomationRunDetail.pendingEffect`). */
  effect: SimulationEffectPreview | null;
}

/** Un'esecuzione nel blocco Home «Automations», con il motivo per cui riguarda chi guarda. */
export interface MyAutomationRun extends AutomationRunRow {
  /** Aspetta me; fallita di un'automazione che gestisco; di un'automazione mia, non finita. */
  concern: "waiting_me" | "failed" | "owner";
}

/**
 * Un'esecuzione nella sezione «Automations» di un progetto. Senza
 * `linkable` (una generale che chi guarda non vede, shape [A 23]) restano
 * solo codice, titolo e stato: niente registro né nome dell'automazione.
 */
export interface ProjectAutomationRun {
  id: string;
  n: number;
  code: string;
  title: string;
  status: RunStatus;
  startedAt: string;
  automationCode: string;
  automationName: string;
  linkable: boolean;
}

/** La sezione «Automations» di un progetto (shape automations.md [A 22]). */
export interface ProjectAutomationsView {
  /** La voce della colonna c'è: qualcosa da vedere, o chi guarda può crearne. */
  show: boolean;
  canCreate: boolean;
  automations: AutomationRow[];
  /** Le esecuzioni non finite delle automazioni del progetto e delle generali che vi hanno agito. */
  runs: ProjectAutomationRun[];
  /** Le generali che vi hanno agito: solo a chi le vede. */
  general: { id: string; code: string; name: string; lastActedAt: string; runCount: number }[];
}

/** «Created by automation …» su una task o un traguardo: senza nomi né link se non la vedo [A 24]. */
export type AutomationOrigin =
  | { visible: false }
  | { visible: true; code: string; name: string; n: number; entry: string | null };

export interface AutomationSearchResult {
  kind: "automation" | "run";
  id: string;
  code: string;
  label: string;
  route: string;
  /** Lo stato in parola (⌘K): dell'automazione o dell'esecuzione. */
  status: Automation["status"] | RunStatus;
}

/** Nome e descrizione di un'automazione. */
export interface AutomationMeta {
  name?: string;
  description?: string;
}

// --- Automations (area 7): la prova ----------------------------------------------
//
// Le anteprime della prova: cosa FAREBBE un passo, risolto con le regole
// dell'esecuzione vera. Nessun codice (non nasce niente): una cosa si lega
// al suo passo col percorso (`path`, R-J5), e il registro della prova ha
// `effects[].code` sempre vuoto.

/** Un progetto in un'anteprima; uno che chi prova non vede ha id, codice e nome vuoti (R-G5). */
export interface SimulationProject {
  id: string;
  code: string;
  name: string;
}

interface SimulationAt {
  stepId: string;
  /** Il percorso del passo (R-J5), giro compreso. */
  path: string;
}

export interface SimulationTaskPreview extends SimulationAt {
  project: SimulationProject;
  title: string;
  description: string;
  assigneeId: string | null;
  departmentId: string | null;
  /** Come si è scelto l'incaricato: la persona, il reparto (senza incaricato), il primo col ruolo nel progetto, nessuno. */
  assignedBy: "person" | "department" | "role" | "none";
  role: string | null;
  /** L'avviso del registro (es. nessuno ha il ruolo: la task nascerebbe senza incaricato). */
  warning: ReasonCode | null;
  dueDate: string | null;
  dueInDays: number | null;
  /** Il traguardo che nascerebbe da un passo precedente della prova. */
  milestone: { name: string; stepId: string; path: string } | null;
}

export interface SimulationMilestonePreview extends SimulationAt {
  project: SimulationProject;
  name: string;
  dueDate: string | null;
  dueInDays: number | null;
}

export interface SimulationRequestPreview extends SimulationAt {
  project: SimulationProject;
  title: string;
  description: string;
}

export interface SimulationEmailPreview extends SimulationAt {
  /** La casella del proprietario da cui partirebbe. */
  from: string;
  to: string;
  subject: string;
  body: string;
  attachments: string[];
  /**
   * Partirebbe come risposta nella conversazione aperta dall'email di quel
   * passo (stesso indirizzo, come nell'esecuzione vera: il promemoria
   * risponde alla richiesta); `null` = una conversazione nuova.
   */
  sameConversationAs: { stepId: string; path: string } | null;
}

export interface SimulationNotificationPreview extends SimulationAt {
  personId: string;
  text: string;
  project: SimulationProject | null;
}

/** «Avvia un'altra automazione»: la prova dice solo che partirebbe, non ne percorre i passi. */
export interface SimulationStartPreview extends SimulationAt {
  automationId: string;
  code: string;
  name: string;
}

export interface SimulationClaudePreview extends SimulationAt {
  outcome: string | null;
  fields: Record<string, unknown>;
  reason: string;
  /** I documenti che Claude ha letto (nomi), per «Read: …». */
  read: string[];
}

/** Un evento d'esempio per la prova: dalla sorgente, o un oggetto vero recente che chi prova vede. */
export interface SimulationExample {
  /** Una riga leggibile (es. «Nuovo contratto – Rossi Srl», «AUD-12 Titolo»). */
  label: string;
  /** Il codice dell'oggetto vero, se è una task o una richiesta. */
  code: string | null;
  at: string | null;
  event: Record<string, unknown>;
}

export type SimulationEffectPreview =
  | ({ kind: "task" } & SimulationTaskPreview)
  | ({ kind: "milestone" } & SimulationMilestonePreview)
  | ({ kind: "request" } & SimulationRequestPreview)
  | ({ kind: "email" } & SimulationEmailPreview)
  | ({ kind: "notification" } & SimulationNotificationPreview)
  | ({ kind: "start" } & SimulationStartPreview);

/** Dove la prova si è fermata ad aspettare chi prova. */
export type SimulationWaiting =
  | (SimulationAt & {
      kind: "approval";
      who: Extract<Approval, { mode: "ask" }>["who"];
      /** Chi approverebbe davvero, risolto adesso (nella prova approva chi prova). */
      realApproverIds: string[];
      /** Chi sarebbe il proprietario. */
      ownerId: string;
    })
  | (SimulationAt & {
      kind: "event";
      /** Fin quando aspetterebbe: «Avanti» manda un input `time` con questa data. */
      until: string;
      wait: Extract<Step, { kind: "wait" }>["for"];
      /** L'email a cui si aspetta risposta (`replyTo`), se nella prova è partita. */
      email: SimulationEmailPreview | null;
      /** La task di cui si aspetta la chiusura (`taskClosed`). */
      task: SimulationTaskPreview | null;
    })
  | (SimulationAt & {
      kind: "project";
      clientKey: string;
      clientName: string | null;
      /** Chi sceglierebbe davvero il progetto. */
      ownerId: string;
      /**
       * I progetti fra cui scegliere: quelli che il proprietario vedrebbe
       * (come nell'esecuzione vera), fra quelli che chi prova vede (R-G5);
       * per codice.
       */
      choices: SimulationProject[];
    });

/** Un confronto del filtro dell'inizio su un esempio della prova (area 10b, D3). */
export interface FilterCheck {
  condition: Condition;
  /** Il valore del dato nell'esempio (null se manca). */
  value: unknown;
  matches: boolean;
}

export interface SimulationView {
  id: string;
  automationId: string;
  automationCode: string;
  automationName: string;
  /** La versione provata, e se è la bozza. */
  version: number;
  draft: boolean;
  /** Chi sarebbe il proprietario: chi prova per una bozza (accenderla lo farebbe tale), altrimenti quello di adesso. */
  ownerId: string;
  event: Record<string, unknown>;
  /** `running` = pronta per «Passo successivo»; le attese, la fine, il fallimento come in un'esecuzione. */
  status: RunStatus;
  /**
   * Area 10b (D3): il filtro dell'inizio non vale per l'esempio, quindi la
   * vera non partirebbe. La prova è `done` subito, senza anteprime, e non
   * conta come provata. Facoltativo: assente vale `false`.
   */
  filteredOut?: boolean;
  /**
   * Con `filteredOut`: ogni confronto del filtro col valore dell'esempio e il
   * suo esito, calcolati dal livello dati (la pagina li legge soltanto).
   * Facoltativo: assente = nessun confronto da mostrare.
   */
  filterChecks?: FilterCheck[];
  /**
   * Area 10b (D2): la prova l'ha fatta Claude sul suo esempio — un evento vero
   * (codice e titolo, come li vede chi l'ha chiesta) o uno scritto da lui. La
   * pagina della prova adottata lo dice senza riconoscere l'evento da sé.
   * Facoltativo: assente = una prova fatta a mano.
   */
  claudeExample?: { code: string | null; title: string | null; written: boolean };
  /**
   * Area 7, F3 (D4, F3-3 = a): la prova è arrivata al primo passo di Claude e
   * aspetta che chi prova confermi il costo stimato, una volta per tutta la
   * prova. Facoltativo: assente o `null` = niente da confermare.
   */
  costToConfirm?: { claudeSteps: number; estimateUsd: number; model: string } | null;
  error: string | null;
  cursor: string | null;
  /** L'«adesso» della prova (va avanti con «Avanti»). */
  now: string;
  log: RunLogEntry[];
  vars: Record<string, unknown>;
  loops: Record<string, unknown[]>;
  /**
   * Gli elementi di ogni «Per ogni» entrato nella prova (per percorso del
   * passo), anche a giri finiti: i titoli dei giri («Round 3 of 6 · …»).
   */
  loopItems: Record<string, unknown[]>;
  /**
   * Il passo al cursore, quando sta per fare qualcosa (pronto per «Passo
   * successivo», o in attesa di approvazione): la sua anteprima, o il
   * fallimento con cui la vera si fermerebbe.
   */
  current: {
    stepId: string;
    path: string;
    kind: Step["kind"];
    preview: SimulationEffectPreview | null;
    failure: { error: string; reason: string | null; why: ReasonCode | null } | null;
  } | null;
  waiting: SimulationWaiting | null;
  /** Tutto ciò che farebbe, finora. */
  preview: {
    tasks: SimulationTaskPreview[];
    milestones: SimulationMilestonePreview[];
    requests: SimulationRequestPreview[];
    emails: SimulationEmailPreview[];
    notifications: SimulationNotificationPreview[];
    starts: SimulationStartPreview[];
    claude: SimulationClaudePreview[];
  };
}

// --- la prova nel client (F1, P1 = a) -------------------------------------------------

/**
 * Una persona come la legge la prova: chi un passo può nominare o
 * raggiungere, fra quelle che chi prova vede.
 */
export interface SimulationPerson {
  id: string;
  name: string;
  departmentIds: string[];
  isClaude: boolean;
  deactivated: boolean;
  /** Il reparto in cui una sua richiesta finirebbe (`null`: nessuno). */
  defaultDepartmentId: string | null;
}

/** Un progetto che i passi della versione provata toccano (il proprio e i fissi). */
export interface SimulationContextProject {
  id: string;
  code: string;
  name: string;
  /** Archiviato o eliminato: per nessuno. */
  gone: boolean;
  /** Chi lo vede, fra le persone del contesto (chi prova e il proprietario compresi). */
  seenBy: string[];
  /** I permessi del proprietario nel progetto, calcolati dal server. */
  ownerCan: { createTask: boolean; createMilestone: boolean; createRequest: boolean };
  /** Chi ha il ruolo (per nome), in ordine alfabetico: le stesse regole degli approvatori veri. */
  roleHolders: Record<string, string[]>;
  /** I membri di ogni reparto che vedono il progetto. */
  departmentMembers: Record<string, string[]>;
  /**
   * I nomi dei traguardi che il progetto ha già (il nome è unico per
   * progetto: `milestoneNameTaken`, confronto esatto). Vuoto per un progetto
   * che chi prova non vede. Assente da un server più vecchio = nessuno noto.
   */
  milestoneNames?: string[];
}

/**
 * I fatti che i piani della prova leggono, risolti dal server per chi prova
 * e per il proprietario che la versione avrebbe: il client non deduce né
 * chi approva né chi può fare cosa.
 */
export interface SimulationContext {
  /** L'automazione, con la versione provata fra le sue. */
  automation: Automation;
  version: number;
  draft: boolean;
  /** La revisione provata (R-J19): `POST …/tested` la rimanda. */
  rev: number | null;
  /** Chi sarebbe il proprietario: chi prova per una bozza, altrimenti quello di adesso. */
  ownerId: string;
  /** `configErrorsOf` per questa versione e questo proprietario (anche `not_available`). */
  configErrors: FlowIssue[];
  people: SimulationPerson[];
  projects: SimulationContextProject[];
  /**
   * La casella da cui la versione provata manderebbe le email, per il
   * proprietario che avrebbe (area 7, F2): quella scelta all'accensione se è
   * lui, altrimenti la sua prima utilizzabile; o il motivo per cui non c'è.
   * È ciò che `EmailWorld.ownerMailbox` della prova restituisce. Assente da
   * un server più vecchio.
   */
  ownerMailbox?: OwnerMailbox;
}

/** `GET /api/automations/:code/examples?version=`: gli esempi e il contesto della prova. */
export interface SimulationExamplesView {
  items: SimulationExample[];
  context: SimulationContext;
}

/** `POST /api/automations/:code/test/estimate` (area 7, F3, C-F3-2): la stima gratuita della prova. */
export interface AutomationTestEstimate {
  /** I passi di Claude raggiungibili, coi giri dei «per ogni» dell'esempio. */
  claudeSteps: number;
  /** `null`: il modello non ha una tariffa nota (mai uno zero inventato). */
  estimateUsd: number | null;
  model: string;
  /**
   * Un «per ogni» su un elenco che l'esempio non ha (lo decide Claude) è stato
   * contato col MASSIMO dei giri (50): la stima è un tetto, non il previsto.
   * Assente da un server più vecchio.
   */
  upperBound?: boolean;
}

/** `POST /api/automations/:code/test/claude` (area 7, F3, D4): il risultato di un passo di Claude della prova. */
export interface AutomationTestClaudeResult {
  outcome?: string;
  fields?: Record<string, unknown>;
  reason: string;
  /** Gli input tagliati a 20 000 caratteri (F3-5). */
  truncated?: string[];
}

