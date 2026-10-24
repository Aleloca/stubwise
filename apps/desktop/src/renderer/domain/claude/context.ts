import type {
  DecisionRequest,
  DocPage,
  FilterCriteria,
  Person,
  Project,
  ProjectPulse,
  ProjectRequest,
  ProjectStatus,
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
}
