import type {
  ActionClass,
  ConversationFilter,
  ConversationRow,
  DecisionRequest,
  DocPage,
  DriveFile,
  FilterCriteria,
  Person,
  Project,
  ProjectPulse,
  ProjectRequest,
  ProjectStatus,
  ProposedAction,
  Task,
  WeeklyBrief,
} from "../../data/types";

/** La `t` della lingua di chi conversa (come in `domain/export.ts`). */
export type T = (key: string, options?: Record<string, unknown>) => string;

/**
 * Le letture che il motore usa: le funzioni del livello dati, già filtrate
 * per la persona della sessione. Il chiamante passa quelle vere
 * (`data/api.ts` le soddisfa così come sono); il motore non sa nulla di
 * permessi né di visibilità — un oggetto che non vede gli arriva `null` o
 * non gli arriva affatto, come a mano.
 */
export interface ReadApi {
  listProjects(): Promise<Project[]>;
  listPinnedProjectIds(): Promise<string[]>;
  listProjectPulses(): Promise<ProjectPulse[]>;
  listProjectStatuses(projectId: string): Promise<ProjectStatus[]>;
  getLatestBrief(projectId: string): Promise<WeeklyBrief | null>;
  listPeople(): Promise<Person[]>;
  listTasks(criteria?: FilterCriteria): Promise<Task[]>;
  getTaskByCode(code: string): Promise<Task | null>;
  getRequest(id: string): Promise<ProjectRequest | null>;
  getRequestByCode(code: string): Promise<ProjectRequest | null>;
  listDecisionRequests(filter: {
    taskId?: string;
    askedOfId?: string;
    open?: boolean;
  }): Promise<DecisionRequest[]>;
  listDocPages(projectId: string): Promise<DocPage[]>;
  /**
   * I file del Drive che Claude può leggere per chi chiede (visibili, non
   * nascosti, disponibili e pronti, col testo estratto). Leggerli non conta
   * un'apertura.
   */
  readDriveFiles(): Promise<DriveFile[]>;
  /**
   * Area 10a, le righe D: dove porta il link. Le conversazioni (la domanda
   * aperta di Claude su una task), le automazioni e i server del progetto,
   * sempre come li vede chi chiede.
   */
  listConversations(filter: ConversationFilter): Promise<ConversationRow[]>;
  listAutomations(): Promise<{ code: string }[]>;
  listProjectServers(projectId: string): Promise<{ code: string }[]>;
  /**
   * Area 10a (Task 9): chi chiede può registrare decisioni nel progetto? La
   * riga D di «registra la decisione» non promette un dialogo che non si
   * aprirebbe. Il permesso lo dice il livello dati; il motore non lo deduce.
   */
  canRecordDecisions(projectId: string): Promise<boolean>;
}

export interface IntentContext {
  /** Chi conversa: le proposte sono sue, e solo lui le può confermare. */
  personId: string;
  /** Il contesto di progetto facoltativo della conversazione libera. */
  contextProjectId: string | null;
  read: ReadApi;
  t: T;
  /**
   * Rende unico l'id delle proposte (es. id della conversazione + numero del
   * messaggio): il motore è puro, quindi lo stesso testo con lo stesso seme
   * dà la stessa proposta.
   */
  seed?: string;
  /**
   * Una chiamata da un thread della Chat: i messaggi del thread prima della
   * chiamata, dal più vecchio, già filtrati per chi chiama (con i codici di
   * ciò che citano). «Pianificala per W45» sotto un messaggio su AUD-4
   * parla di AUD-4. Fuori dalla Chat non c'è.
   */
  thread?: readonly string[];
  /**
   * Chi chiama può rispondere a una domanda di Claude prima della proposta
   * (una chiamata dalla Chat, R-G4, e la conversazione libera, area 10b):
   * una richiesta a cui manca un pezzo («assegna AUD-4», senza a chi)
   * diventa una domanda a scelta invece di una risposta di solo testo. Nella
   * libera si spegne dopo due domande per la stessa richiesta.
   */
  asks?: boolean;
  /**
   * La classe calcolata dal livello dati (area 10a), solo nella
   * conversazione libera: con A l'azione parte subito (`Answer.execute`),
   * con B o C diventa una scheda. Senza (la Chat, R-G1) tutto resta
   * proposta. Il motore la chiede, non la deduce.
   */
  classify?: (actions: Pick<ProposedAction, "fn" | "args">[]) => Promise<ActionClass>;
}
