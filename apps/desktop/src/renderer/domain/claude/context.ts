import type { FlowIssue } from "../automations/validate";
import type {
  ActionClass,
  ArchiveCandidates,
  AutomationFlow,
  ContextRef,
  ConversationFilter,
  ConversationRow,
  DecisionRequest,
  Department,
  DocPage,
  DriveFile,
  FilterCriteria,
  PageAction,
  Person,
  Project,
  ProjectPulse,
  ProjectRequest,
  ProjectStatus,
  ProposedAction,
  SpendView,
  StalledProject,
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
  /**
   * Area 10b (S1): i reparti (dati configurabili, gli stessi per tutti), per
   * la scheda di scelta e per nominarli in una frase.
   */
  listDepartments(): Promise<Department[]>;
  /**
   * Area 10b (S1): chi chiede può creare automazioni in `projectId` (null =
   * generali)? Lo dice il livello dati; il motore non lo deduce.
   */
  canManageAutomations(projectId: string | null): Promise<boolean>;
  /**
   * Area 10b (S1): i problemi del flusso che Claude sta per creare, come li
   * vedrebbe la prova (la stessa regola che il catalogo ricontrolla).
   */
  validateAutomationFlow(flow: AutomationFlow, projectId: string | null): Promise<FlowIssue[]>;
  /**
   * Area 10b (S2): i progetti aperti e visibili con task ferme, dal più
   * fermo (`stallOf`, come il blocco «Stalled»); con `projectId` solo quello
   * (P16).
   */
  listStalledProjects(projectId?: string | null): Promise<StalledProject[]>;
  /**
   * Area 10b (S2): l'«adesso» del livello dati (l'orologio unico `now()`),
   * per il «Read at …» dei «Details». Nessun dato.
   */
  now(): Promise<string>;
  /** Area 10b (S3): la spesa in AI del mese, come chi chiede la vede in Usage. */
  spendThisMonth(): Promise<SpendView>;
  /**
   * Area 10b (S4): i progetti aperti e visibili senza attività da `days`,
   * divisi per ciò che chi chiede può fare (`archiveCandidatesFor`).
   */
  listArchiveCandidates(days: number): Promise<ArchiveCandidates>;
  /** Area 10b (S5): le persone che chi chiede vede, il cui nome (o nome e cognome) è `name`, senza maiuscole. */
  findPeople(name: string): Promise<Person[]>;
  /** Area 10b (S5): i ruoli di progetto, nell'ordine dei preset. */
  listProjectRoles(): Promise<{ id: string; name: string }[]>;
  /**
   * Area 10b (S5): chi chiede può dare il ruolo nel progetto? `forbidden`
   * se lì non gestisce i membri (qualunque sia il ruolo), `escalation` se il
   * ruolo ha permessi che lì non ha. Lo dice il livello dati.
   */
  canGrantRole(projectId: string, roleId: string): Promise<"ok" | "escalation" | "forbidden">;
  /** Area 10b (S5): il ruolo (id) della persona nel progetto; `null` se non ne è membro. */
  memberRoleOf(projectId: string, personId: string): Promise<string | null>;
  /** Area 10b (S5, Q2 del controller): chi chiede può invitare persone? */
  canInvitePeople(): Promise<boolean>;
  /**
   * Area 10b (Task 8): il codice e il progetto di un contesto, come chi
   * chiede lo vede (`contextOf`); `null` se non lo vede. Serve alle frasi
   * (il «Who?», «Open the reply →»): il motore non legge lo stato.
   */
  describeContext(
    ref: ContextRef,
  ): Promise<{ code: string | null; projectId: string | null } | null>;
  /** Area 10b (S6): l'id della conversazione di supporto col codice (`ACQ-S2`), se chi chiede la vede. */
  supportConversationIdOf(code: string): Promise<string | null>;
  /** Area 10b (S6): la bozza della risposta (`draftText`), se chi chiede ha `support.reply`; altrimenti `null`. */
  supportReplyDraft(conversationId: string): Promise<string | null>;
  /** Area 10b (S6b): la bozza delle note di una PR, se chi chiede può modificarle; altrimenti `null`. */
  releaseNotesDraft(prId: string): Promise<{ text: string; sources: string[] } | null>;
  /** Area 10b (D1): la bozza del corpo di un'email (`threadId` `null` = l'email nuova). */
  mailDraft(
    threadId: string | null,
    hint: string,
  ): Promise<
    { ok: true; text: string; used: string[] } | { ok: false; reason: "not_found" | "hint" }
  >;
  /** Area 10b (D1): la bozza della descrizione di una task, dalle sue fonti. */
  taskDescriptionDraft(
    taskId: string,
  ): Promise<
    | { ok: true; text: string; sources: string[] }
    | { ok: false; reason: "not_found" | "forbidden" | "no_source" }
  >;
}

/**
 * Area 10b (Task 9): la pagina di chi chiede, com'è adesso. Lingua e tema
 * dicono se una richiesta è già fatta («Il tema è già scuro»); `lastFilter`
 * è «questo filtro»: l'ultimo `pageAction` `filter` `done` della
 * conversazione (P21) — il contesto della pagina non porta la ricerca.
 */
export interface PageState {
  theme: "system" | "light" | "dark";
  language: "en" | "it";
  lastFilter: Omit<Extract<PageAction, { kind: "filter" }>, "kind"> | null;
}

export interface IntentContext {
  /** Chi conversa: le proposte sono sue, e solo lui le può confermare. */
  personId: string;
  /** Il contesto di progetto facoltativo della conversazione libera. */
  contextProjectId: string | null;
  /**
   * Area 10b (Task 8): ciò che chi chiede ha davanti (il chip del riquadro),
   * solo se lo vede (`contextOf`): dice in quale campo va una bozza.
   */
  context?: ContextRef | null;
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
  /** Area 10b (Task 9): la pagina di chi chiede, solo nella libera (il riquadro la cambia). */
  page?: PageState;
}
