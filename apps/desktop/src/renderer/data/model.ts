import type { StallReason, TicketPriority } from "@stubwise/shared";
import type {
  ClaudeActionFn,
  ClaudeBusyReason,
  ClassReason,
  ExecutedFailure,
} from "./claude/types";

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
  /**
   * Chiave di un `PRESET_ROLES` di `@stubwise/shared` (ruolo tipico della
   * persona). È solo seme: da qui `data/access/seed.ts` ricava il ruolo
   * d'istanza e le appartenenze; il ruolo vero sta nello stato `access`.
   */
  presetRole: string;
  /**
   * Campo calcolato da `listPeople` (area 9a), mai salvato: la persona è
   * disattivata, quindi resta nominata dalle sue task ma non si assegna.
   */
  deactivated?: boolean;
  /**
   * L'email d'accesso cambiata in Account (area 9a). Assente = quella del
   * seme (l'account Google o `nome.cognome@example.com`): la si legge sempre
   * da `person()` di `seed/mail/helpers.ts`, mai da qui direttamente.
   */
  email?: string;
  /** La foto del profilo (area 9a): un data URL tenuto in memoria; assente = le iniziali. */
  photo?: string;
  /**
   * Solo per Claude nella build app (integrazione area 3, 3e.2): i progetti in
   * cui chi guarda può assegnargli una task (`claudeAssignableProjectIds`,
   * calcolati dal server da `runs.start`). Sul server Claude non è membro di
   * nessun progetto; nel prototipo è assente e vale `memberIds`. Lo legge
   * `assignableIn` (`data/assignable.ts`).
   */
  assignableProjectIds?: string[];
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
  signals: {
    claudeWorking: boolean;
    /**
     * Area 9b, solo nelle letture: c'è lavoro di Claude nato ma fermo (la
     * coda in pausa, il budget), col blocco che vale adesso.
     */
    claudeWaiting?: AiBlock | null;
  };
  /** Il tetto delle correzioni automatiche per PR (impostazione di progetto); assente = 3. */
  correctionCap?: number;
  /** Area 9c, General: la descrizione del progetto; assente = vuota. */
  description?: string;
  /**
   * Area 9c, Archive: archiviato, da chi e quando; assente o `null` = attivo.
   * Un archiviato non è in `visibleProjectIds` di nessuno, full admin e
   * Claude compresi: lo leggono solo i suoi ex membri e il full admin, dalla
   * scheda «Archived» (Task 5).
   */
  archived?: { at: string; byId: string } | null;
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
   * Integrazione area 2, fetta 1 (solo build app): una card di un'area non
   * ancora integrata non apre niente nell'app nuova, ma il web vecchio sì —
   * il percorso dell'istanza («Open in web»). Il prototipo non la valorizza.
   */
  webHref?: string;
  /**
   * Solo una menzione della Chat: il messaggio. Titolo e testo si derivano a
   * lettura dal messaggio di adesso (eliminato o non più leggibile: la
   * notifica non c'è più), mai salvati qui.
   */
  chatMessageId?: string;
  /**
   * Solo un avviso di un server senza accesso di lettura usabile (area 8b):
   * dove si collega l'accesso SSH. Derivato a lettura per chi guarda (solo
   * con `servers.ssh.manage`), mai salvato qui.
   */
  linkAccessHref?: string;
  /**
   * Area 10a: la task della notifica è stata eliminata. Derivato a lettura
   * da `state.deletedTasks` (`listNotifications`), mai salvato qui: la
   * notifica resta, ma non apre niente.
   */
  objectGone?: boolean;
  /**
   * Area 10a: l'ha fatta partire Claude per `personId` (il riquadro o una
   * conferma di @Claude nella Chat), nell'azione `actionId`. Scritto al
   * momento, perché è vero solo allora; assente sulle notifiche scritte a
   * mano e su quelle nate prima.
   */
  viaClaude?: { personId: string; actionId: string };
  /**
   * Area 10a, solo a lettura (`listNotifications`): il nome di
   * `viaClaude.personId` per il prefisso «Claude on behalf of …», `null` se
   * chi guarda non vede quella persona (R-G5). Mai salvato.
   */
  viaClaudeName?: string | null;
  /**
   * Area 10a: solo `planning.changed`, la settimana pianificata come valore
   * stabile (`2026-W46`; `null` = tolta dalla settimana), scritta al momento
   * perché la frase si traduca a lettura invece di leggere il corpo salvato
   * in inglese. Assente sulle notifiche nate prima.
   */
  plannedWeek?: string | null;
  /**
   * Area 10a, solo a lettura (`listNotifications`): chi ha annullato
   * l'azione di Claude che l'ha fatta partire («Undone by Giulia Ferri»).
   * Si deriva da `viaClaude.actionId` → l'azione → `undone.byId`; mai salvato.
   */
  undoneByName?: string | null;
  /**
   * Area 10a (I2 della revisione finale): chi ha fatto la scrittura di una
   * notifica diretta (`publish`), come valore stabile, perché `task.assigned`
   * e `planning.changed` si compongano a lettura nella lingua di chi legge
   * anche senza Claude. Non esce mai al client: `listNotifications` lo
   * sostituisce con `actorName`. Assente sulle righe nate prima.
   */
  actorId?: string;
  /**
   * Area 10a, solo a lettura: il nome di `actorId` se chi guarda vede quella
   * persona, `null` se no (R-G5); assente se la riga non ha `actorId`.
   */
  actorName?: string | null;
  /**
   * Area 10b (D4, P25): solo `member.added`, il ruolo dato come valore
   * stabile; il nome si legge a lettura (`roleName`). Assente sulle altre.
   */
  roleId?: string;
  /**
   * Area 10b, solo a lettura: il nome di adesso di `roleId` (rinominato, il
   * nome nuovo); `null` se il ruolo non esiste più [SC 15]. Mai salvato.
   */
  roleName?: string | null;
  /**
   * Area 10b, solo a lettura: chi guarda non vede più il progetto della
   * notifica (un `member.added` annullato, [SC 16]). La notifica resta, ma
   * non apre niente. Mai salvato.
   */
  notOpenable?: boolean;
  /**
   * Area 11a (Q1, ruling P19): solo `product_doc.mention`, la pagina e il
   * filo (la radice) della menzione, come valori stabili scritti al
   * momento. Titolo, corpo e `objectGone` si derivano a lettura da qui.
   * Assente sulle altre.
   */
  productComment?: { pageId: string; rootId: string };
  /**
   * Area 11a, solo a lettura: il titolo di adesso della pagina della
   * menzione (rinominata, quello nuovo). Assente se la notifica non apre
   * più niente (`objectGone`): chi non legge la pagina non ne sa il titolo.
   */
  productPageTitle?: string;
  /**
   * Area 11a, solo a lettura: i nomi menzionati nel commento che chi guarda
   * vede (R-G5), perché la card li scriva in 600. Mai salvato.
   */
  mentionNames?: string[];
  /**
   * Area 11b: solo `product_doc.updated`, la pagina, le revisioni scritte e
   * le fonti, come valori stabili scritti al momento (una card per fonte;
   * dopo un rilascio della coda, una per pagina con più fonti). `waited`:
   * la card arriva dopo un'attesa della coda (budget o pausa). Titolo, corpo
   * e `objectGone` si derivano a lettura (`presentProductUpdate`). Assente
   * sulle altre, e una riga senza si legge come `objectGone`.
   */
  productUpdate?: {
    pageId: string;
    revisionIds: string[];
    sources: ProductSourceRef[];
    waited?: AiBlock["reason"];
  };
  /**
   * Area 11b: solo `product_doc.question`, la pagina e il commento-domanda.
   * Come `productUpdate`, si legge a lettura (`presentProductQuestion`).
   */
  productQuestion?: { pageId: string; commentId: string };
  /**
   * Area 11b, solo a lettura: quello che la card di `product_doc.updated` o
   * `product_doc.question` dice, già visto da chi riceve (le fonti nella sua
   * forma, R-G5 e §21; i nomi solo se li vede). Assente con `objectGone`.
   * Mai salvato.
   */
  productCard?: ProductCardView;
}

/**
 * Quello che una card della doc di prodotto (11b) dice, per chi la legge. I
 * testi li compone la card in en/it da questi valori stabili.
 */
export interface ProductCardView {
  /** Le fonti, ognuna come la legge chi riceve (`sourceViewOf`), in ordine d'arrivo. */
  sources: ProductSourceView[];
  /** Quante frasi (ancore) hanno cambiato le revisioni; 0 per una domanda. */
  changes: number;
  /** Una fonte sola di una persona: «per conto di» (`null` per Claude o per chi non si vede). */
  onBehalfOfName: string | null;
  /** La card arriva dopo un'attesa della coda: il budget o la pausa. */
  waited: AiBlock["reason"] | null;
  /** Solo `product_doc.question`. */
  question?: {
    reason: ProductQuestionReason;
    /** La persona nominata dalla domanda (chi ha scritto la frase, o il titolare senza permesso). */
    forName: string | null;
    /** Il codice della task di una divergenza (anche invisibile: `CodeLink` lo mostra tenue). */
    taskCode: string | null;
    answer: ProductAnswerChoice | null;
    answeredByName: string | null;
    /** La domanda ha una richiesta da proporre (la frase della divergenza la offre solo allora). */
    canRequest?: boolean;
  };
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
  | "done"
  /** Area 9b: la sessione è nata ma aspetta la coda (o il budget): Claude non lavora ancora. */
  | "waiting";
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
  /** `null` sul server vero se chi l'ha segnata non c'è più. */
  byId: string | null;
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
  /** Chi l'ha creata; `null` sul server vero per una task senza autore umano (SDK, posta…) o un utente eliminato. */
  createdById: string | null;
  followerIds: string[];
  size: TaskSize | null;
  /** ISO (YYYY-MM-DD). */
  dueDate: string | null;
  /** Settimana ISO, es. "2026-W43". */
  plannedWeek: string | null;
  slipCount: number;
  /**
   * Solo sul server vero (fetta 2): chi guarda può spostarla nel Planning,
   * calcolato dal server (`canMove` coi suoi permessi). Assente nel prototipo
   * e da un server più vecchio: allora decide `canMove` sul client.
   */
  canPlan?: boolean;
  /**
   * Solo nella risposta di una scrittura che ha appena assegnato la task a
   * Claude (build app, review dell'area 3 punto 5): l'esito dell'avvio del
   * lavoro, `started` o `refused:<codice>`. Assente altrove e nel prototipo.
   */
  claudeRun?: string;
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
  /**
   * Campo calcolato dalla vista della task (area 9a), mai salvato: se
   * l'assegnatario è disattivato la task dice «(deactivated)». `null` senza
   * assegnatario.
   */
  assigneeStatus?: "active" | "deactivated" | null;
}

/** Una task eliminata (area 10a): il codice resta preso per sempre (non si riusa). */
export interface DeletedTask {
  id: string;
  code: string;
  projectId: string;
  title: string;
  deletedAt: string;
  deletedById: string;
  /** Area 10a: eliminata da Claude per `deletedById`; assente se a mano. */
  via?: "claude";
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

/**
 * Il lavoro di Claude su una task in breve (integrazione area 2, fetta 1): lo
 * stato, le PR e dove continuare nel web vecchio (piano, approvazione,
 * domande, sessione dal vivo). È ciò che la build app mostra finché l'area 3
 * non è integrata; il prototipo ha la sezione completa (`TaskWork`).
 */
export interface TaskWorkSummary {
  claude: ClaudeWorkState;
  pullRequests: { repo: string; number: number | null; url: string; state: "open" | "merged" | "closed" }[];
  /** Il dettaglio del ticket nel web vecchio; `null` nel prototipo (non c'è un web vecchio). */
  webHref: string | null;
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
  /** L'id del provider d'istanza (area 9b): i consumi lo nominano, il nome si può cambiare. */
  id?: string;
}

/**
 * Perché un lavoro AI nuovo non parte adesso (area 9b): il budget del mese
 * è esaurito (ovunque), oppure la coda del progetto è in pausa, con chi l'ha
 * messa e da quando. Lo calcola `aiBlockFor` (`instance/blocks.ts`).
 */
export type AiBlock =
  | { reason: "monthly_budget" }
  | { reason: "queue_paused"; byId: string; byName: string; since: string };

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
  /** Area 10a: scritta da Claude per `authorId`; assente se a mano o nata prima. */
  via?: "claude";
  /**
   * Area 10a: l'azione di Claude che l'ha scritta. Serve al «com'era» di
   * «Annulla» (Task 5) per riconoscere le scritture del gruppo stesso.
   */
  claudeActionId?: string;
  /**
   * Area 10a: `nextSeq()` dell'ultima scrittura della voce (nascita,
   * modifica, eliminazione di un commento): il «com'era» di «Annulla» ordina
   * con questo, perché `at` è lo stesso per tutta la sessione (P4). Assente
   * sulle voci del seme.
   */
  seq?: number;
}

export interface DecisionRequest {
  id: string;
  taskId: string;
  /** Build app: il progetto della task, se il server lo dice (il polso non dipende dalla lista delle task). */
  projectId?: string;
  /** `null` sul server vero se chi ha chiesto non c'è più. */
  askedById: string | null;
  askedOfId: string;
  question: string;
  options: string[];
  createdAt: string;
  withdrawnAt: string | null;
  answer: { optionIndex: number | null; text: string | null; at: string; byId: string | null } | null;
}

export type RequestStatus = "new" | "refining" | "ready" | "converted" | "archived";
/** I tre livelli (urgenza, rischio) di una richiesta: l'unico elenco, in ordine. */
export const REQUEST_LEVELS = ["low", "medium", "high"] as const;
export type RequestLevel = (typeof REQUEST_LEVELS)[number];

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
  /** Solo sul server vero (fetta 3): la voce nel web vecchio, finché Requests non è integrata (fetta 4). */
  webHref?: string;
  /**
   * Solo sul server vero (fetta 4): la risposta a «Nuova richiesta» è questa
   * richiesta perché l'intake vi ha fuso quella appena mandata («Unita a R12»).
   */
  landedByMerge?: boolean;
  /**
   * Solo sul server vero (fetta 4): l'urgenza era «urgent», più alta di
   * «high» che l'app mostra; si segna senza perdere il dato.
   */
  urgent?: boolean;
  /**
   * Ciò che l'intake (AI) propone di cambiare nei metadati, col perché: resta
   * una proposta finché chi ha `backlog.edit` non la accetta o la scarta.
   * Assente o `null`: nessuna proposta.
   */
  suggestions?: RequestSuggestions | null;
  /**
   * Da dove è nata, se non a mano: una conversazione di Support (widget o
   * server MCP, area 8a), o una pagina della doc di prodotto (11b: «Apri una
   * richiesta» da una domanda di Claude, le voci proposte da una pagina).
   * Una richiesta non nasce MAI da un'email: una domanda nata da un'email
   * porta alla pagina, non all'email.
   */
  origin?: { kind: "support"; conversationId: string } | ProductDocOrigin;
  /**
   * 11b (P38): la pagina della doc di prodotto da cui nasce, come la legge
   * chi guarda («Dalla doc: <pagina>»). Derivata a lettura (`getRequest`,
   * `getRequestByCode`, `listRequests`), mai salvata; assente se non nasce
   * dalla doc o se chi guarda non legge la pagina (e allora manca anche
   * l'`origin` grezza della doc: l'id della pagina dice di cosa parla).
   */
  productOrigin?: ProductOrigin;
  /**
   * Area 10a: i codici delle task nate da questa richiesta e poi eliminate.
   * Derivato a lettura da `state.deletedTasks` (`getRequest`,
   * `getRequestByCode`, `listRequests`), mai salvato qui.
   */
  deletedTaskCodes?: string[];
  /**
   * Area 10a (Task 10): quante delle task nate da lei esistono ancora — il
   * «N tasks» dell'elenco. Derivato a lettura come `deletedTaskCodes`, e
   * assente sulle letture che non lo calcolano (vale allora `taskIds.length`).
   */
  taskCount?: number;
}

/**
 * Una richiesta nata dalla doc di prodotto (11b): la pagina, l'ancora (o
 * `null` = la pagina intera) e, se nasce da «Apri una richiesta», la domanda
 * di Claude che la richiesta chiude.
 */
export interface ProductDocOrigin {
  kind: "product_doc";
  pageId: string;
  anchorId: string | null;
  questionId?: string;
}

/** «Dalla doc: <pagina>» come lo legge chi guarda (11b, P38): la pagina, mai la frase. */
export interface ProductOrigin {
  pageId: string;
  code: string;
  title: string;
}

/** Una richiesta nata da una pagina, nelle voci in fondo alla pagina (11b, shape backlog §3.3). */
export interface ProductLinkedRequest {
  id: string;
  code: string;
  title: string;
  status: RequestStatus;
  /** Le task nate dalla richiesta che esistono ancora. */
  taskCodes: string[];
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
  /** `null` sul server vero per i filtri di esempio (di nessuno, modificabili da un full admin). */
  ownerId: string | null;
  visibility: "private" | "public";
  criteria: FilterCriteria;
  view: TaskView;
  groupBy: GroupBy;
  /**
   * Solo sul server vero (fetta 3): chi guarda può modificarlo ed eliminarlo,
   * calcolato dal server. Assente nel prototipo: decide `canManageFilter`.
   */
  canEdit?: boolean;
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

/**
 * Area 10a: ciò che chi scrive sta guardando (il chip del riquadro di
 * Claude). Solo id e valori stabili: il chip e «· on ACQ-14» si rileggono
 * con la visibilità di chi guarda, e un oggetto invisibile non ha chip (R-G5).
 */
export type ContextRef =
  | { kind: "release"; releaseId: string }
  | { kind: "task"; taskId: string }
  | { kind: "request"; requestId: string }
  | { kind: "support"; conversationId: string }
  | { kind: "pr"; prId: string }
  | { kind: "automation"; automationId: string }
  /** `section`: la voce di Settings del progetto, o d'Amministrazione (`ai`, `ai.models`) con `projectId` `null`. */
  | { kind: "settings"; projectId: string | null; section: string }
  /** Una pagina senza oggetto: la sezione del progetto (`tasks`) o la destinazione (`home`). */
  | { kind: "page"; route: string; projectId: string | null }
  /**
   * Area 10b (D1): la Posta — una conversazione (`threadId`) o l'email nuova
   * di `compose=new` (`null`). Solo nella propria casella (`mailbox_owner`).
   */
  | { kind: "mail"; threadId: string | null };

/** Un campo che una pagina dichiara riempibile (area 10b, design parte 1). */
export type FieldRef =
  | { kind: "supportReply"; conversationId: string }
  | { kind: "releaseNotes"; prId: string }
  /** D1: il corpo di una risposta (`threadId`) o di un'email nuova (`null`), solo nella propria casella. */
  | { kind: "mailBody"; threadId: string | null }
  /** D1: la descrizione di una task, nel campo aperto di `DescriptionSection`. */
  | { kind: "taskDescription"; taskId: string };

/**
 * Area 10b (Task 9): ciò che Claude cambia della pagina di chi chiede —
 * lingua, tema, il filtro della pagina sotto. Valori stabili: la riga li
 * dice nella lingua di chi guarda.
 */
export type PageAction =
  | { kind: "language"; to: "en" | "it" }
  /** I valori di `ThemePreference` (`theme/theme.ts`), scritti qui: `model.ts` non importa dal tema. */
  | { kind: "theme"; to: "system" | "light" | "dark" }
  /** `route` e `search` come li usa la pagina: Tasks legge i criteri da `filters`. */
  | { kind: "filter"; route: string; search: Record<string, unknown> };

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
  /**
   * Area 10a, solo le sessioni di lavoro nate nella sessione: `nextSeq()`
   * all'apertura. Una sessione nata sulla task dopo un'azione di Claude è
   * una scrittura «dopo» per il «com'era» di «Annulla» (P4).
   */
  seq?: number;
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
  /**
   * Build app (chat, fetta 5): i nomi che dà il server dell'autore (solo
   * quando non è chi guarda) e di chi l'ha resa pubblica, anche per chi non
   * ha progetti in comune con chi guarda. Assenti nel prototipo.
   */
  ownerName?: string | null;
  publishedByName?: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** Solo sessione di lavoro: con quale account o chiave gira (il nome). */
  provider?: RunProvider | null;
  /**
   * Solo sessione di lavoro aperta dall'area 9b in poi: il modello con cui è
   * partita (`modelFor` dell'operazione di `OPERATION_OF_KIND`), come id
   * («claude-haiku-5-5»). Un cambio successivo in Models non lo riscrive.
   */
  model?: string;
  /**
   * Solo sessione di lavoro (area 9b): la sessione è nata ma aspetta, ferma
   * da un blocco d'istanza (`aiBlockFor`): la coda del progetto in pausa (o,
   * alla ripresa, il budget). Nessun evento finché non parte; `null` o
   * assente: non aspetta.
   */
  waiting?: AiBlock | null;
  /**
   * Area 9b: la sessione è nata in attesa (la coda in pausa). `resumedById`
   * è chi ha ripreso la coda (`null` finché aspetta, o se è ripartita perché
   * è tornato il budget), con quando: la storia del lavoro lo racconta.
   */
  queued?: { resumedById: string | null; resumedAt: string | null };
  /** Area 9b: il modello di `fix_execute` quando l'esecuzione è partita (la storia lo dice se è diverso). */
  executionModel?: string;
  /**
   * Area 9c: l'account che il progetto usa in esclusiva («Use only this
   * account»), scritto alla nascita della sessione; `null` (o assente)
   * senza esclusività. Con `provider: null` dice perché la sessione non ha
   * un account («No account free: AUD uses only Backup Max»): un cambio
   * successivo in Settings → AI non lo riscrive.
   */
  requiredProvider?: { name: string } | null;
  /**
   * Area 9c: le skill che entrano nella sessione (`skillsForRun` del suo
   * progetto alla nascita), nell'ordine. Un cambio successivo in Settings →
   * Plugins non le riscrive; assente sulle sessioni nate prima del 9c.
   */
  skills?: { plugin: string; skill: string }[];
  /** Solo sessione di lavoro: i consumi per modello. */
  usage?: ModelUsage[];
  /** Solo sessione di lavoro fallita: il riassunto del fallimento, in una riga. */
  failureSummary?: string | null;
  /**
   * Solo libera: l'oggetto di contesto con cui è nata («Chiedi a Claude di
   * spiegarlo» su un rilascio, area 8a). Resta di chi la apre (privacy area 3).
   */
  context?: ContextRef | null;
  /**
   * Solo `task_run`: la correzione di un server (area 8b), avviata da una
   * task con `serverRef`. Il suo piano va sempre approvato da una persona.
   */
  serverFix?: { serverCode: string };
  /**
   * Solo `server_analysis`: il server che l'analisi guarda, con l'accesso
   * di lettura (la testata e la fascia di sola lettura lo nominano).
   */
  serverAnalysis?: { serverCode: string };
  /**
   * Solo `server_analysis`: i limiti con cui è partita (`ANALYSIS_MAX_*`),
   * scritti accanto ai consumi (`usage`): oltre, l'analisi si ferma
   * `timed_out` e apre la task con ciò che ha visto.
   */
  analysisLimits?: { maxMinutes: number; maxCostUsd: number };
}

export interface Attachment {
  id: string;
  name: string;
  sizeBytes: number;
  kind: "image" | "file";
  /**
   * Solo una bozza della casella della Chat nella build app (area 4, fetta 4):
   * il file scelto, che l'invio carica nel canale prima del messaggio. Mai in
   * un allegato già inviato.
   */
  file?: Blob;
}

/**
 * Una frase di Claude registrata come chiave i18n e parametri, non come
 * testo: si legge nella lingua di chi guarda, adesso. I parametri sono dati
 * (codici, titoli, nomi), mai frasi.
 */
export type Utterance = { key: string; params?: Record<string, string | number> };

/** Una modifica ai dati che Claude propone: la esegue la mutazione di oggi, a nome di chi conferma. */
export type ProposedAction = {
  /** Le azioni del catalogo di Claude (area 10a: dalla foglia dei tipi, mai da `claude/catalog.ts`, P10) e quelle della Posta. */
  fn:
    | ClaudeActionFn
    // Dalla posta (area 6): una decisione nel registro (origine `email`, testo
    // da template) e la scelta del progetto per un'email incerta
    // (`chooseProject` non si esegue: la risolve `chooseProjectFor`). Il
    // traguardo della posta è `createMilestone` del catalogo.
    | "recordDecision"
    | "chooseProject"
    // Dal calendario (area 6): «Ricordamelo» di una serie. Non crea nulla:
    // chi la conferma prende atto e la proposta si chiude (come
    // `acknowledge_reminder` del web).
    | "acknowledgeReminder";
  args: Record<string, unknown>;
  summary: string;
  /** Il riassunto come frase (`summary` è la sua resa al momento, per chi non la sa leggere). */
  summaryText?: Utterance;
  /**
   * Area 10b (S4): il perché dell'azione in un fatto, sotto la sua riga
   * della scheda («last activity: Aug 4»). Una frase: si legge nella lingua
   * di chi guarda. Assente sulle azioni nate prima.
   */
  why?: Utterance;
  /** 11b (fix round 1): solo `updateProductPage`, le frasi; il `why` lo compone la lettura per chi legge. */
  productPreview?: ProductUpdatePreviewData;
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
      /**
       * Area 10a: la pagina da cui è partito (il chip del riquadro). Un
       * riferimento, non un contenuto: si rilegge con la visibilità di chi
       * guarda (`describeContext`). Assente sui messaggi nati prima.
       */
      context?: ContextRef | null;
    }
  /**
   * `text` cresce mentre arriva; `done` quando il messaggio è completo.
   * `productWeek` (11b): la risposta come dato, ricomposta per chi legge e
   * tolta dalla lettura.
   */
  | {
      id: string;
      at: string;
      type: "assistant";
      text: string;
      done: boolean;
      productWeek?: ProductWeekAnswer;
    }
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
      /**
       * Solo un comando su un server (area 8b): con quale accesso SSH è
       * girato. La UI lo legge per dire «read»/«fix» (mai il nome dello
       * strumento) e per disegnarlo come riga del registro dei comandi.
       */
      access?: "read" | "fix";
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
      /**
       * `item_closed`: il refine si è chiuso perché la richiesta è stata
       * trasformata, archiviata o fusa. Correzione di un server (area 8b),
       * fase fermata SENZA una persona: `fix_access_revoked` (l'accesso di
       * correzione è stato revocato) o `fix_access_unusable` (non è più
       * usabile: verifica fallita, lettura che scrive) o `server_gone` (il
       * server non è più in un ambiente del progetto). Lo Stop di una
       * persona porta `stoppedById`; tempo scaduto ed errore hanno il loro
       * `outcome` (`timed_out`, `failed`).
       */
      reason?: "item_closed" | "fix_access_revoked" | "fix_access_unusable" | "server_gone";
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
      options: {
        label: string;
        consequence?: string;
        recommended?: boolean;
        /** Area 10b: l'opzione è un reparto (S1), la scheda ne disegna la striscia. */
        departmentId?: string;
      }[];
      answer: { optionIndex: number | null; text: string | null; byId: string; at: string } | null;
      /**
       * Area 10b, solo nella libera: la richiesta da riprendere. La risposta
       * le si accoda («assegna MKX-31» + «Giulia Ferri») e Claude riprende
       * da lì. Assente: una domanda di un lavoro (`ask_user`).
       */
      resume?: string;
    }
  | {
      id: string;
      at: string;
      type: "plan";
      planText: string;
      summary: string;
      /**
       * Correzione di un server (area 8b): i comandi previsti, uno per riga
       * col perché, come li legge chi approva. Scritti col piano.
       */
      commands?: { input: string; why: string }[];
      /** `undecided` (build app): nessun esito verificabile — il piano non è stato deciso. */
      status: "pending" | "approved" | "rejected" | "pre_approved" | "undecided";
      decidedById?: string;
      instructions?: string;
      /**
       * Build app: il digest del piano (dal server). Chi decide rimanda
       * QUESTO, il piano che ha davanti (review dell'area 3, punto 13).
       */
      digest?: string;
    }
  | {
      id: string;
      at: string;
      type: "proposal";
      proposalId: string;
      requesterId: string;
      /**
       * Build app (chat, fetta 5): chi guarda può confermarla o annullarla,
       * come dice il server (`canConfirm`/`canCancel` della vista). Assente nel
       * prototipo, dove decide il richiedente. La scheda lo legge, non lo deduce.
       */
      canDecide?: boolean;
      actions: ProposedAction[];
      status: "open" | "confirmed" | "cancelled" | "expired" | "failed";
      error?: string;
      resultCodes?: string[];
      /** Confermata solo in parte («Confirm selected»): gli indici delle azioni eseguite. */
      confirmedActions?: number[];
      /** Eseguita dal dialogo di «Modifica», con i valori cambiati da chi l'ha chiesta. */
      edited?: boolean;
      /**
       * Area 10a: la classe calcolata dal livello dati quando la scheda è
       * nata (B o C) e i suoi motivi; assenti nelle proposte nate prima e in
       * quelle della Chat. La scheda li legge, non li deduce.
       */
      cls?: "A" | "B" | "C";
      reasons?: ClassReason[];
      /** Area 10a: il gruppo di azioni eseguito dalla conferma (`state.claudeActions`), per «Annulla». */
      groupId?: string;
      /** Area 10a (Task 9): il codice dell'oggetto di ogni azione eseguita (task, richiesta, progetto). */
      objectCodes?: (string | null)[];
      /** Area 10a (Task 9): il rifiuto della conferma in forma di dato, per «Couldn't do it: … · Who?». */
      failure?: ExecutedFailure;
      /**
       * Area 10a (I1 della revisione finale): la scheda di un «Annulla» il cui
       * inverso avviserebbe qualcuno o farebbe partire un'automazione. È il
       * gruppo che annulla; le azioni sono gli inversi, coi riassunti delle
       * azioni annullate. La conferma gira come un «Annulla».
       */
      undoOf?: string;
      /**
       * Area 10b (S4): le righe sotto la scheda che non sono azioni — i
       * progetti che chi chiede vede ma non gestisce e quelli occupati.
       * Mai un oggetto che chi chiede non vede (R-G5).
       */
      notes?: ProposalNote[];
      /**
       * Area 10b (S5): la scheda nasce bloccata — il ruolo da dare ha
       * permessi che chi chiede lì non ha (`canGrantRole`). Il ruolo è un
       * id: la frase lo nomina a lettura. Confirm è spento (Task 11).
       */
      blocked?: { kind: "escalation"; roleId: string };
    }
  /**
   * Area 10a: azioni di Claude eseguite senza scheda (classe A) nella
   * conversazione libera. `pending` c'è solo fra il motore e l'esecuzione
   * (`freeTurn`): non arriva mai a chi legge.
   */
  | {
      id: string;
      at: string;
      type: "executed";
      groupId: string;
      actions: ProposedAction[];
      status: "pending" | "done" | "failed";
      resultCodes?: string[];
      /** Perché non è partita (`claude.executed.failed.<codice>`). */
      errorText?: Utterance;
      /** Area 10a (Task 9): il codice dell'oggetto di ogni azione eseguita (task, richiesta, progetto). */
      objectCodes?: (string | null)[];
      /** Area 10a (Task 9): il rifiuto in forma di dato, per «Didn't run: … · Who?». */
      failure?: ExecutedFailure;
    }
  /**
   * Area 10b (S1): la prova di Claude della bozza appena creata, sui suoi
   * esempi (`wants`). `pending` c'è solo fra il motore e `freeTurn`, che la
   * risolve subito dopo l'`executed` che l'ha creata: `done` coi risultati
   * (la prova non ha effetti), `skipped` se la creazione non è partita o è
   * diventata una scheda (nessuna riga). I risultati sono dati: chi guarda
   * li legge nella sua lingua.
   */
  | {
      id: string;
      at: string;
      type: "trial";
      status: "pending" | "done" | "skipped";
      wants: ("passes" | "fails")[];
      automationId?: string;
      /** Il codice dell'automazione provata (`ACQ-A4`). */
      code?: string;
      /** Un esito per esempio, nell'ordine di `wants`; un esempio che Claude non è riuscito a scrivere non c'è. */
      results?: (TrialOutcome & { label: Utterance; written: boolean })[];
      /** La prova che il riquadro apre da sé nel costruttore (D2, maintainer): la prima che passa. */
      openSimId?: string | null;
    }
  /**
   * Area 10b (S2): una riga sotto la risposta che non è un fatto della
   * prima riga — una deduzione («Hypothesis», mai nella prima riga) o come
   * è contato («Details», chiuso). Testo di Claude nella lingua di chi ha
   * chiesto, come il `say` (ruling T5).
   */
  | {
      id: string;
      at: string;
      type: "aside";
      kind: "hypothesis" | "details";
      text: string;
    }
  /**
   * Area 10b (S0): la risposta onesta, cosa sa fare il prototipo. Dati: chi
   * guarda legge etichette e frasi d'esempio nella sua lingua.
   */
  | { id: string; at: string; type: "capabilities"; items: CapabilityId[] }
  /**
   * Area 10b (S6, S6b, D1): una bozza di Claude per un campo. Non scrive
   * dati: il testo va nel campo della pagina (Task 10), e diventa di
   * qualcuno solo con «Send»/«Save» della persona. Il testo è contenuto
   * scritto da Claude nella lingua di chi l'ha chiesta, come il `say`.
   * `field` `null` e `text` vuoto: com'è letta da chi non vede l'oggetto del
   * campo, o non è il proprietario della casella (`presentEventFor`, R-G5);
   * nel flusso salvato `field` c'è sempre.
   */
  | {
      id: string;
      at: string;
      type: "draft";
      field: FieldRef | null;
      text: string;
      /** I codici citati (note di rilascio): ogni riga ne ha uno. */
      sources?: string[];
      /** `pending` fino al riquadro; `placed` nel campo; `waiting` = pagina lasciata («Put it in the field»). */
      status: "pending" | "placed" | "waiting" | "undone" | "changed_after";
    }
  /**
   * Area 10b (Task 9): un'azione della pagina (lingua, tema, filtro), classe
   * A: tocca solo chi chiede. `pending` fino al riquadro di chi ha aperto la
   * conversazione, che la esegue una volta (`usePageEventRunner`) e la chiude
   * con `settlePageEvent`; il valore di prima resta solo nella sua memoria.
   */
  | {
      id: string;
      at: string;
      type: "pageAction";
      action: PageAction;
      status: "pending" | "done" | "undone" | "changed_after" | "failed";
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
      /**
       * Solo `server_check` (R-L3): l'esito del controllo in sola lettura
       * dopo la correzione. Dice «risolto/non risolto»; l'esito della
       * sessione no (può chiudersi male per altri motivi).
       */
      resolved?: boolean;
      /**
       * Solo `server_check`: il dettaglio scritto da Claude (cosa ha riletto),
       * senza l'intestazione, che la UI scrive nella lingua di chi guarda da
       * `resolved`. `text` resta la frase intera (inglese, come Claude).
       */
      detail?: string;
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
  | { step: "say"; text: string; productWeek?: ProductWeekAnswer }
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
      /** Un comando su un server: con quale accesso (lo copia nell'azione). */
      access?: "read" | "fix";
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
  /** L'account git d'istanza con cui Stubwise ci lavora (area 9b); `null` = nessuno. */
  gitAccountId?: string | null;
  // --- area 9c: Progetto → Settings → Repositories ---
  /** L'indirizzo del repository sulla piattaforma (https). */
  url?: string;
  /** Il comando di install nel worktree; `null` = rilevato dal lockfile. */
  installCommand?: string | null;
  /** Il comando dei test; `null` = rilevato. */
  testCommand?: string | null;
  /** L'account git che firma le review; `null` = il revisore predefinito dell'istanza. */
  reviewGitAccountId?: string | null;
  /** Il grafo del codice per le chat (`graphEnabled` del web): si salva e basta. */
  graphEnabled?: boolean;
  /** I rami su cui Claude non spinge mai; «release/*» vale come prefisso. */
  protectedBranches?: string[];
  /**
   * Il webhook git (push e PR) sulla piattaforma. Il secret non c'è mai:
   * solo il suo id nel caveau (`admin/secrets.ts`) e le ultime 4 cifre.
   */
  webhook?: {
    state: "not_configured" | "configured" | "failed";
    configuredAt: string | null;
    secretId: string | null;
    last4: string | null;
  };
}

/**
 * Un file d'ambiente di un repository, in un ambiente del progetto (area
 * 9c). Di ogni variabile si tiene il nome e quando è stata scritta; il
 * valore sta solo nel caveau (`secretId`), e il seme non ne ha (`null`).
 * Solo i file dell'ambiente `test` arrivano a Claude (`CLAUDE.md`).
 */
export interface EnvFile {
  id: string;
  repositoryId: string;
  environmentId: string;
  /** Il percorso nel worktree, es. «.env» o «apps/api/.env». */
  path: string;
  vars: { key: string; secretId: string | null; setAt: string }[];
}

/**
 * Un repository rimasto senza progetto dopo un Delete (maintainer, 31 ott
 * 2026). Sta fuori da `state.repositories`, così `Repository.projectId` resta
 * `string` e nessuna lettura di progetto lo incontra; collegarlo lo rimette
 * lì col progetto nuovo. `formerProjectId` si risolve a lettura con
 * `deletedProjects` (R-G5).
 */
export interface DetachedRepository {
  repository: Repository;
  formerProjectId: string;
  detachedAt: string;
  detachedById: string;
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
  /**
   * La chiave dell'indirizzo dello spazio (`#/p/<CODE>/docs/<chiave>`): lo slug
   * del repository nella build app (stabile, sicuro in un URL). Assente nel
   * prototipo, dove la chiave è il nome. Si legge con `spaceKey`.
   */
  slug?: string;
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
  /**
   * Lo spazio Prodotto del progetto (area 11a): quante pagine, l'ultima
   * modifica, se chi guarda scrive. Facoltativo (cambio additivo): una
   * lettura senza il campo vale «nessuno spazio Prodotto da mostrare».
   */
  product?: { pageCount: number; updatedAt: string | null; canEdit: boolean } | null;
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
  /**
   * La fonte di ogni pagina citata: il repository, oppure `space: "product"`
   * per una pagina di prodotto (allora `repositoryName` è vuoto). Facoltativo:
   * una risposta senza il campo è dei soli repository.
   */
  sources: { pageId: string; repositoryName: string; space?: "product" }[];
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
  /**
   * L'OCR si è fermato alle prime 30 pagine (build app, F3 dell'area 5): il
   * resto del documento non si trova cercando. Il prototipo non lo conosce.
   */
  ocrPartial?: boolean;
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
  /** Il File stesso: lo carica la build app (il prototipo non manda byte). */
  file?: File;
}

/** Avanzamento e annullamento di un caricamento (la build app; il prototipo li ignora). */
export interface DriveUploadOptions {
  /** I byte del file mandati fin qui. */
  onProgress?: (loaded: number) => void;
  signal?: AbortSignal;
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
   * Build app: chi guarda può modificare / eliminare il messaggio, come lo
   * calcola il SERVER (una risposta di Claude: chi l'ha chiamata, D6).
   * Assenti nel prototipo, dove la UI li ricava dall'autore e dal canale.
   */
  canEdit?: boolean;
  canDelete?: boolean;
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
  /**
   * Solo `system`: l'evento e l'oggetto della scheda. `gone` (build app): l'oggetto
   * non c'è più (una task eliminata), la scheda dice solo il tipo dell'evento.
   */
  event?: { kind: ChatEventKind; ref: CitationRef; gone?: boolean };
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
    /**
     * Build app (fetta 3): fermare, rifare e rispondere alla domanda come li
     * calcola il SERVER per chi guarda. Assenti nel prototipo, dove la UI li
     * ricava da chi ha chiamato e dallo stato.
     */
    canStop?: boolean;
    canRetry?: boolean;
    canAnswer?: boolean;
  };
}

/**
 * Perché una risposta di @Claude non è finita: chi l'ha chiamato non legge
 * più il canale (`forbidden`), qualcosa che serviva non c'è più
 * (`not_found`), il budget mensile dell'istanza è finito (`budget`, solo
 * nella build app: il server non fa partire il turno), o un errore
 * qualunque (`other`).
 */
export type ChatClaudeFailure = "forbidden" | "not_found" | "budget" | "other";

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
  | {
      mode: "fixed";
      projectId: string;
      /**
       * Area 9c ([PX 5]): il progetto scelto non è più disponibile — eliminato
       * (lo scrive `purge.ts`, senza id) o, a lettura, archiviato o invisibile
       * a chi legge (`flowFor`, senza id). Il costruttore lo dice («A project
       * that's no longer available»); scegliendo un altro progetto sparisce.
       */
      unavailable?: true;
    }
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
  | {
      id: string;
      kind: "notify";
      /**
       * Una persona, un ruolo, o un reparto (area 10b): l'avviso va a ogni
       * membro del reparto che vede il progetto del passo, uno per persona.
       */
      who: PersonTarget | { departmentId: string };
      text: string;
      approval: Approval;
    }
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
  /**
   * Area 10b: creata da Claude per conto di `createdById` (il riquadro). Resta
   * per sempre, anche dopo l'accensione (maintainer, shape [AU 8]). Assente:
   * creata a mano.
   */
  createdVia?: "claude";
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

/**
 * L'esito della prova di Claude su un esempio (area 10b, `trialAs`): sta qui
 * e non in `data/automations/*` perché lo legge l'evento `trial` della
 * conversazione, e `model.ts` non importa da lì (la stessa ragione di P10).
 */
export interface TrialOutcome {
  simId: string;
  /** `filtered_out`: il filtro dell'inizio non passa (D3). */
  status: RunStatus | "filtered_out";
  tasks: number;
  notifications: number;
  emails: number;
  requests: number;
  milestones: number;
  /** Chi dovrebbe approvare alla prima fermata `waiting_approval`; `null` se non c'è o chi chiede non lo vede (R-G5). */
  approverId: string | null;
  /** Il passo di Claude su cui la prova si è fermata (non lo esegue: la prova di Claude non chiama `claudeFake`). */
  stoppedAtClaude: boolean;
}

/**
 * Area 10b (S0): le cose che il prototipo sa fare, nell'ordine dell'elenco
 * (maintainer, 2 nov 2026: nove voci, con email e descrizione di D1).
 * Stanno qui perché le legge l'evento `capabilities` (P5).
 */
export type CapabilityId =
  | "automation"
  | "stalled"
  | "spend"
  | "archive"
  | "addMember"
  | "supportReply"
  | "releaseNotes"
  | "mailBody"
  | "taskDescription"
  // 11b (Task 8): la doc di prodotto.
  | "productFirstVersion"
  | "productUpdate"
  | "productBacklog"
  | "productWireframe"
  | "productChanges";

/** Area 10b (S4): una riga sotto la scheda di un'azione in blocco. */
export type ProposalNote =
  /** Progetti che chi chiede vede ma non gestisce: il numero dei visibili, col «Who?». */
  | {
      kind: "not_manageable";
      count: number;
      whoAction: string;
      /** I codici di quei progetti, tutti visibili a chi chiede: il «Who?» per progetto (maintainer, 2 nov 2026, SC 11). Facoltativo. */
      codes?: string[];
    }
  /** Un progetto `busy`, con le ragioni di `busyReasonsOf` come le legge chi chiede. */
  | { kind: "busy"; code: string; reasons: ClaudeBusyReason[] }
  /**
   * 11b (P35): le frasi della pagina già proposte (una richiesta con la stessa
   * pagina e ancora). `codes` = quelle che chi chiede vede, `hidden` le altre,
   * contate e mai nominate.
   */
  | { kind: "already_proposed"; codes: string[]; hidden: number };

/**
 * Area 10b (S4): i progetti aperti e visibili senza attività da un numero di
 * giorni, divisi per ciò che chi chiede può fare. Sta qui perché lo legge il
 * motore puro (P5).
 */
export interface ArchiveCandidates {
  candidates: { projectId: string; code: string; name: string; lastActivity: string }[];
  busy: { code: string; reasons: ClaudeBusyReason[] }[];
  notManageable: number;
  /** I codici dei non gestibili (tutti visibili a chi chiede), per la nota `not_manageable`. */
  notManageableCodes: string[];
}

/**
 * Perché una task è ferma (`stallOf` in `domain/stalled.ts`), in ordine di
 * precedenza. Dall'integrazione area 2 vive in `@stubwise/shared` (la regola la
 * usa anche il server): qui si ri-esporta.
 */
export type { StallReason };

/**
 * `StallReason` come la legge chi chiede (R-G5): la persona della decisione
 * e la task che blocca ci sono solo se le vede, altrimenti la forma senza.
 */
export type SeenStallReason =
  | Exclude<StallReason, { kind: "decision" } | { kind: "blocked_by" }>
  | { kind: "decision"; personId?: string }
  | { kind: "blocked_by"; taskId?: string };

/** Area 10b (S2): un progetto aperto e visibile con task ferme, per la risposta di Claude. */
export interface StalledProject {
  projectId: string;
  code: string;
  stalled: number;
  /** La task ferma da più tempo, col motivo di `stallOf` (P6). */
  oldest: { taskCode: string; days: number; reason: SeenStallReason; plannedWeek: string | null };
  /** La soglia del progetto (`stallThresholds.activeDays`), per i «Details» ([SC 3], P6). */
  thresholdDays: number;
}

/**
 * Area 10b (S3): la spesa in AI del mese (dal 1° a `now()`), come la vede
 * chi chiede. `asOf` è l'«adesso» della lettura, per i «Details».
 */
export type SpendView =
  | {
      scope: "instance";
      totalUsd: number;
      budgetUsd: number | null;
      /** I 3 che spendono di più; `projectId` `null` = «Other projects» (solo `usage.view`). */
      top: { projectId: string | null; code: string | null; usd: number }[];
      asOf: string;
    }
  | {
      scope: "projects";
      totalUsd: number;
      projects: { projectId: string; code: string; usd: number }[];
      asOf: string;
    }
  | { scope: "none" };

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
   * `code: ""`: né id né codice. Una task eliminata (area 10a) che chi
   * guarda vedeva ha `deleted: true`: si legge «task deleted», senza link.
   */
  effects: { kind: string; code: string; deleted?: true }[];
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
  /**
   * Solo nelle letture (area 9b, ruling 15): resta `running`, ferma al
   * confine di un passo di Claude per un blocco d'istanza (budget del mese,
   * coda in pausa). Riparte da sola quando il blocco cade.
   */
  aiWaiting?: AiBlock | null;
  /**
   * Solo nelle letture, con `aiWaiting` `queue_paused`: il codice del
   * progetto la cui coda è in pausa (sempre un progetto che chi guarda vede).
   */
  aiWaitingCode?: string | null;
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
  /** Area 10b: i commit della PR, dal più vecchio; assente = non letti. */
  commits?: { sha: string; message: string }[];
  /**
   * Area 10b (S6b): le note di rilascio, scritte da una persona
   * (`setPrReleaseNotes`); il merge le copia sul rilascio. Assente o `null`:
   * nessuna nota. Una bozza di Claude non arriva mai qui da sola.
   */
  releaseNotes?: string | null;
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
  /** Area 10b (S6b): le note della PR al momento del merge; assente o `null`: nessuna. */
  releaseNotes?: string | null;
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
  /**
   * Area 9b (revisione finale M4): l'analisi non è partita per il budget del
   * mese raggiunto all'apertura dell'episodio. Il riquadro «Now» lo dice;
   * l'analisi non riparte da sola quando il budget torna.
   */
  analysisBlocked?: "monthly_budget" | null;
}

/** L'analisi automatica di un episodio, in sola lettura: una sessione e, alla fine, una task. */
export interface ServerAnalysis {
  id: string;
  serverCode: string;
  episodeId: string;
  projectId: string;
  conversationId: string;
  /**
   * `stopped`: finita senza diagnosi, perché il server è rientrato prima
   * della prima lettura o perché l'accesso di lettura ha smesso di essere
   * usabile (revoca, lettura che scrive); la task c'è e lo dice. Anche
   * quando il server è stato tolto dal progetto a metà: lì senza task
   * (`taskId` null), lo dice la sessione. `failed`:
   * la task non si è potuta aprire (la sessione dice perché).
   */
  outcome: "running" | "diagnosed" | "unreachable" | "timed_out" | "stopped" | "failed";
  taskId: string | null;
  startedAt: string;
  endedAt: string | null;
  /**
   * La proposta scritta con la diagnosi («Suggested fix» della sezione
   * Server della task); assente se l'analisi non ne ha una.
   */
  proposal?: string | null;
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

/** L'esito di una «Verifica» dei due accessi SSH. */
export interface SshVerification {
  at: string;
  read: "ok" | "failed" | "writes";
  fix: "ok" | "failed";
  reason: string | null;
  /** La verifica era delle chiavi in `pending`. */
  ofPending: boolean;
}

/**
 * Lo stato degli accessi SSH di un server (nessuna riga = non collegato).
 * `pending`: chiavi generate e non ancora verificate — le prime (in attesa
 * del comando, `keys` nullo) o quelle di una rigenerazione (le vecchie in
 * `keys` restano valide finché la verifica delle nuove non riesce, ma solo
 * se lo erano prima di «Rigenera»).
 */
export interface ServerSshAccess {
  serverCode: string;
  keys: Record<SshAccessKind, SshPublicKey> | null;
  pending: Record<SshAccessKind, SshPublicKey> | null;
  /** L'ultima verifica: delle chiavi in `keys`, o di quelle in `pending` (`ofPending`). */
  verification: SshVerification | null;
  /**
   * L'esito delle chiavi in `keys` quando `verification` riguarda quelle in
   * `pending` (una rigenerazione la cui verifica non è riuscita): senza,
   * l'esito delle vecchie andrebbe perso e un accesso che non passava
   * tornerebbe usabile. `null` in ogni altro caso.
   */
  keysVerification: SshVerification | null;
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

// --- Doc di prodotto (area 11) -----------------------------------------------

/**
 * Un segno dentro una frase, sull'intervallo [start, end) del testo. Un link
 * ha solo un indirizzo http(s) (`safeLinkHref`): ogni altro schema si rifiuta
 * scrivendo e si scarta incollando.
 */
export type InlineMark =
  | { type: "bold" | "italic"; start: number; end: number }
  | { type: "link"; start: number; end: number; href: string };

/**
 * Una frase: testo semplice più segni [start, end), normalizzati (ordinati,
 * mai vuoti, mai sovrapposti fra segni dello stesso tipo). I segni non
 * entrano mai nel testo: niente «**», niente tag.
 */
export interface RichText {
  text: string;
  marks: InlineMark[];
}

export interface ProductTableCell {
  id: string;
  content: RichText;
}

export interface ProductTableRow {
  id: string;
  cells: ProductTableCell[];
}

/**
 * Un blocco della doc di prodotto. L'id è la verità: dividere tiene l'id
 * sulla prima parte, unire tiene quello del primo, e un id (di blocco o di
 * cella) non si riusa mai per un blocco diverso. L'unica eccezione è lo
 * stesso blocco che torna: ⌘Z dell'editor rimette un blocco tolto con il
 * suo id, e i suoi commenti con lui (`writeProductBlocksAs`, `undoOf`).
 * Il 11b aggiunge in coda la bozza di schermata di Claude (`wireframe`): il
 * disegno del seme (`PRODUCT_WIREFRAMES`) e la sua variante; `kept` = chi
 * scrive l'ha tenuta, e l'etichetta «Bozza di Claude» non c'è più. Facoltativo
 * (assente = mai tenuta): «Rifai» lo toglie.
 * Il blocco di codice (`code`, prove a mano del 7 nov 2026, maintainer):
 * testo semplice su più righe (gli a capo sono `\n`, mai segni), con il
 * linguaggio facoltativo (assente = testo semplice), solo un'etichetta:
 * niente colori della sintassi.
 */
export type ProductBlock =
  | { id: string; type: "heading"; level: 1 | 2 | 3; content: RichText }
  | { id: string; type: "paragraph" | "quote"; content: RichText }
  | { id: string; type: "code"; content: RichText; language?: string }
  | { id: string; type: "bullet" | "numbered"; content: RichText; indent: 0 | 1 | 2 }
  | { id: string; type: "todo"; content: RichText; checked: boolean }
  | { id: string; type: "divider" }
  | { id: string; type: "table"; rows: ProductTableRow[] }
  | { id: string; type: "image"; src: string; caption: string; alt: string }
  | { id: string; type: "drive"; fileId: string; code: string }
  | { id: string; type: "decision"; decisionId: string }
  | { id: string; type: "wireframe"; wireframeId: string; variant: number; kept?: boolean };

export type ProductBlockType = ProductBlock["type"];

/** Le operazioni con cui si scrive una pagina: ognuna nomina i blocchi per id. */
export type ProductBlockOp =
  | { op: "set"; block: ProductBlock }
  | { op: "insert"; afterId: string | null; block: ProductBlock }
  | { op: "delete"; blockId: string }
  | { op: "move"; blockId: string; afterId: string | null }
  /** Q3: unisce `secondId` in `firstId` (id e tipo del primo); chi scrive sposta sul primo le ancore del secondo. */
  | { op: "merge"; firstId: string; secondId: string };

export interface ProductBlockChange {
  blockId: string;
  before: ProductBlock | null;
  after: ProductBlock | null;
  /** Le ancore (blocco, o celle di una tabella) il cui testo, i cui segni o la cui presenza sono cambiati. */
  anchors: string[];
  /**
   * Solo per un `merge`: l'ancora assorbita e dove cominciano le sue lettere
   * nel blocco unito. Nasce SOLO da un'operazione `merge` (`applyBlockOps`),
   * mai dal confronto di due elenchi: da due array un'unione e «elimina e
   * riscrivi» sono indistinguibili.
   */
  mergedFrom?: { anchorId: string; offset: number };
}

/** Una pagina di prodotto vista da fuori: albero, recenti, briciole (Task 2 la legge). */
export interface ProductPageRef {
  id: string;
  code: string;
  projectId: string;
  parentId: string | null;
  order: number;
  title: string;
  excerpt: string;
  updatedAt: string;
  updatedById: string;
}

/** Un risultato della ricerca nelle pagine di prodotto (⌘K): come `DocSearchHit`, senza repository. */
export interface ProductSearchHit {
  page: ProductPageRef;
  projectCode: string;
  /** La frase che ha corrisposto (testo semplice, mai segni né indirizzi), una riga. */
  passage: string;
}

export interface ProductTreeNode {
  page: ProductPageRef;
  children: ProductTreeNode[];
}

/**
 * Una pagina dello spazio Prodotto (area 11a). Il codice è della serie dei
 * Docs (`<P>-D<n>`, `state.docCodeSeq`) e non si riusa; `order` è la
 * posizione fra i fratelli (0, 1, 2…). Il corpo sono solo blocchi: nessun
 * Markdown, in nessun campo.
 */
export interface ProductPage {
  id: string;
  code: string;
  projectId: string;
  parentId: string | null;
  order: number;
  title: string;
  blocks: ProductBlock[];
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
}

/** Una fonte di una modifica (11b). Nel 11a nessuna riga la ha. */
export type ProductSourceRef =
  | { kind: "email" | "meeting" | "decision" | "task" | "release"; id: string }
  | { kind: "first_version"; ids: string[] };

/**
 * Un fatto che una fonte (email, riunione, decisione, task, rilascio)
 * dice alla doc di prodotto (11b, `applyProductSource`). È un dato del
 * seme: nessun modello lo legge dal testo. `clarity` dice se il fatto è
 * detto chiaro o è un «forse»; solo uno chiaro, che non contraddice una
 * persona, entra da sé (`decideFact`, `domain/productDocs/claudeRule.ts`).
 */
export interface ProductFact {
  id: string;
  pageId: string;
  /** Il blocco (o la cella) che il fatto riguarda; `null` = in cima alla pagina. */
  anchorId: string | null;
  change:
    | { kind: "replace"; text: RichText }
    | { kind: "insert_after"; block: ProductBlock }
    | { kind: "link_task"; taskCode: string }
    | { kind: "diverges"; built: string };
  clarity: "clear" | "vague";
  /**
   * Il contrasto GIÀ presente quando il fatto arriva, con un testo che
   * nessuna persona ha toccato. Un contrasto nato dopo (una persona che
   * riscrive il blocco mentre Claude aspetta) NON sta qui: lo calcola il
   * motore da `touchedAfter` e lo passa a `decideFact` (preflight P5).
   */
  contradicts?: boolean;
  /** Il testo che il fatto si aspetta di trovare nel blocco (preflight P5). */
  before?: RichText;
  options?: { apply?: RichText; request?: { title: string; description: string } };
  /** La risposta che Claude consiglia; senza, vedi `recommendedOf`. */
  recommended?: "apply" | "keep" | "request";
}

export type ProductFactDecision =
  | { kind: "edit" }
  | {
      kind: "question";
      reason: "vague" | "contradicts_person" | "contradicts" | "diverges" | "no_permission";
    }
  | { kind: "none" };

/** La risposta che Claude può consigliare (o che una persona dà) a una domanda sulla doc. */
export type ProductAnswerChoice = NonNullable<ProductFact["recommended"]>;

/** Perché un fatto è diventato una domanda (preflight P3). */
export type ProductQuestionReason = Extract<ProductFactDecision, { kind: "question" }>["reason"];

/**
 * La domanda di Claude su un'ancora (11b): un commento di `CLAUDE_ID` con
 * le risposte già scritte. Il testo della domanda NON è nel `body` (vuoto):
 * lo compone in lettura chi la mostra, in en o it, da questi valori stabili.
 */
export interface ProductQuestion {
  sourceRef: ProductSourceRef;
  factId: string;
  reason: ProductQuestionReason;
  /**
   * La persona che la domanda nomina: chi ha scritto la frase
   * (`contradicts_person`) o il titolare senza `docs.edit` (`no_permission`);
   * altrimenti `null`.
   */
  forId: string | null;
  /** La frase del fatto, parola per parola («Update it»); `null` = nessuna strada. */
  apply: RichText | null;
  /** Solo `diverges`: cosa è stato fatto. */
  built: string | null;
  request: { title: string; description: string } | null;
  /**
   * Solo un fatto `insert_after` senza `options.apply`: «Aggiorna così»
   * inserisce una copia di questo blocco (con id nuovi) dopo `afterId`
   * (`null` = in cima), invece di riscrivere la frase dell'ancora.
   * Facoltativo: assente, «Aggiorna così» riscrive l'ancora con `apply`.
   */
  insert?: { block: ProductBlock; afterId: string | null };
  recommended: ProductAnswerChoice;
  /**
   * Una sola risposta (Task 4); `revisionId` è la revisione di «Update it»
   * (P19), `requestId` la richiesta aperta da «Open a request».
   */
  answer: {
    byId: string;
    option: ProductAnswerChoice;
    seq: number;
    revisionId: string | null;
    requestId?: string;
  } | null;
}

/**
 * Una domanda di Claude come la legge chi guarda il filo (11b, P18): mai la
 * fonte grezza, ma la sua forma per chi guarda (`sourceViewOf`); le
 * risposte possibili già in ordine; chi può rispondere e perché «Update it»
 * è spento. Il testo della domanda lo compone la UI, in en o it, da
 * `reason`, `forName` e `taskCode`, come la card (`ProductCardView.question`).
 */
export interface ProductQuestionView {
  reason: ProductQuestionReason;
  /** La persona nominata dalla domanda, se chi guarda la vede. */
  forId: string | null;
  forName: string | null;
  /** Il codice della task di una divergenza (anche invisibile: `CodeLink` lo mostra tenue). */
  taskCode: string | null;
  source: ProductSourceView;
  /**
   * Cosa fa «Update it»: `replace` riscrive la frase dell'ancora con `apply`;
   * `insert` aggiunge `apply` come frase nuova dopo l'ancora, che resta com'è.
   */
  applyMode: "replace" | "insert";
  /**
   * La frase dell'ancora com'è adesso («Now» / «The page says»); `null` se
   * non c'è più, e sempre per `insert` (niente da sostituire: solo «Proposed»).
   */
  current: RichText | null;
  apply: RichText | null;
  built: string | null;
  request: { title: string; description: string } | null;
  /** Il consiglio di Claude; `null` se la sua strada non c'è (shape Q §3.2b). */
  recommended: ProductAnswerChoice | null;
  /** Le risposte che hanno una strada, il consiglio per primo, poi apply · keep · request. */
  options: ProductAnswerChoice[];
  /** Chi guarda può rispondere adesso (`docs.edit`, domanda aperta). */
  canAnswer: boolean;
  /** «Update it» spento: la frase è cambiata dopo la domanda (`byId` se chi guarda lo vede). */
  applyBlocked: { byId: string | null } | null;
  answer: {
    byId: string | null;
    byName: string | null;
    option: ProductAnswerChoice;
    revisionId: string | null;
    /** Il codice della richiesta aperta da «Open a request» (`CodeLink` lo mostra tenue se invisibile). */
    requestCode: string | null;
  } | null;
}

/**
 * Un fatto chiaro che aspetta una sezione libera (11b): qualcuno ci scrive
 * (`writersNear`). Riparte su `onProductPresence`, rivalutando la regola:
 * se intanto una persona ha toccato l'ancora (dopo `arrivedSeq`), diventa
 * una domanda.
 */
export interface ProductPendingFact {
  id: string;
  pageId: string;
  projectId: string;
  ref: ProductSourceRef;
  fact: ProductFact;
  /** `nextSeq()` all'arrivo del fatto: il «dopo» di `touchedAfter`. */
  arrivedSeq: number;
  /** Un gesto del riquadro: chi l'ha chiesto non fa aspettare sé stesso. */
  requesterId?: string;
}

/**
 * Una fonte come la legge chi guarda (11b, `sourceViewOf`): UNA funzione
 * per segno, cronologia, card, Home, riga della prima versione e risposte
 * del riquadro. `label` è un `Utterance` da comporre in lettura; per chi
 * non può aprire una email o una riunione dice «da un'email di <titolare>
 * · <data>» e nient'altro: `link: null`, mai l'oggetto né il testo (§21).
 */
export interface ProductSourceView {
  /** Anche le due fonti che solo la prima versione ha: il testo incollato e un file del Drive (P31). */
  kind: ProductSourceRef["kind"] | "text" | "drive";
  label: Utterance;
  /** Il codice di una task o di un rilascio (anche invisibile, tenue); altrimenti `null`. */
  code: string | null;
  /** Solo email e riunione che chi guarda può aprire; il resto lo risolve `CodeLink`. */
  link: string | null;
  /** Il titolare della fonte (chi agisce per lei), se ne ha uno. */
  ownerId: string | null;
  at: string | null;
  /** La fonte non c'è più (email tolta, riunione cancellata). */
  gone: boolean;
}

/**
 * Il segno «Claude's change» di un'ancora (11b): scritto quando Claude
 * cambia l'ancora, e tolto da «Va bene» (`acceptedById`). Una riga per
 * ancora cambiata, perché l'unione di due blocchi deve poterla spostare
 * (`moveProductMarks`, nella scrittura dell'unione).
 */
export interface ProductMark {
  id: string;
  pageId: string;
  anchorId: string;
  revisionId: string;
  acceptedById: string | null;
  acceptedSeq: number | null;
  /**
   * L'ancora che la revisione ha cambiato, quando un'unione ha spostato il
   * segno altrove (`anchorId` è allora il blocco unito). Assente finché il
   * segno resta dov'è nato.
   */
  fromAnchorId?: string;
}

/**
 * Se chi guarda può annullare una modifica di Claude (un'ancora, o tutta la
 * revisione con «Annulla tutto»), e se no perché (11b, Task 3). `byId` è
 * chi ha toccato l'ancora dopo (`changed_after`) o chi l'ha già annullata
 * (`already_undone`), se chi guarda lo vede; `null` altrimenti, e sempre per
 * `no_permission`. `pageId`/`pageTitle` (P34) li dà la prima versione, che
 * tocca più pagine; il segno no.
 */
export type ProductUndoView =
  | { enabled: true }
  | {
      enabled: false;
      reason: "changed_after" | "no_permission" | "already_undone";
      byId: string | null;
      pageId?: string;
      pageTitle?: string;
      /**
       * Solo la prima versione: com'è stata toccata — una modifica, un
       * commento o una risposta, la risposta di un altro a una domanda di
       * Claude, una pagina nuova nello spazio.
       */
      touch?: "edit" | "comment" | "answer" | "page";
    };

/**
 * Il segno di Claude su un'ancora, come lo legge chi guarda (11b, Task 3,
 * `listProductMarks`): tutto derivato in lettura, la pagina non confronta
 * revisioni. Un segno per ancora; per una tabella un segno per cella, con
 * `cell` (1 = la prima riga, la prima colonna, P45) e `blockId` = la tabella.
 */
export interface ProductMarkView {
  anchorId: string;
  /** Il blocco che contiene l'ancora (la tabella, per una cella). */
  blockId: string;
  cell?: { row: number; col: number };
  revisionId: string;
  groupId: string;
  /** Chi agisce: il titolare, o `CLAUDE_ID`. */
  actorId: string;
  /** Il titolare per cui Claude ha agito; `null` per il Claude collega. */
  onBehalfOfId: string | null;
  at: string;
  /** Quante ancore ha cambiato la stessa revisione («Parte di una modifica a 3 frasi»). */
  groupAnchors: number;
  source: ProductSourceView;
  canAccept: boolean;
  undo: ProductUndoView;
}

/**
 * Una fonte scelta per la prima versione di Claude (11b, Task 6): le email
 * e le riunioni del progetto che chi chiede apre, un testo incollato, un
 * file del Drive del progetto (`firstVersionSourcesFor`).
 */
export type FirstVersionSource =
  | { kind: "email"; id: string }
  | { kind: "meeting"; id: string }
  | { kind: "text"; text: string }
  | { kind: "drive"; fileId: string };

/** La fonte come resta nello stato (P31): il testo incollato senza il suo corpo. */
export type FirstVersionSourceRef =
  | Exclude<FirstVersionSource, { kind: "text" }>
  | { kind: "text" };

/** Una pagina della bozza di una prima versione (il seme, o la bozza generica). */
export interface FirstVersionDraftPage {
  /** La chiave della pagina nella bozza (le figlie la nominano in `parentKey`). */
  key: string;
  parentKey: string | null;
  title: string;
  /**
   * I blocchi, con id che valgono solo nella bozza: alla scrittura prendono
   * id nuovi. `onlyWith` = la fonte che dice il blocco: entra solo se quella
   * fonte è fra le scelte (`drive:<fileId>`, `email:<id>`…). Nella bozza del
   * seme OGNI blocco la ha (anti-obiettivo «decisioni inventate»).
   */
  blocks: (ProductBlock & { onlyWith?: string })[];
  /**
   * Le domande di Claude sulla pagina: ogni dubbio delle fonti, su un blocco
   * della bozza (`anchorKey` = il suo id nella bozza).
   */
  questions?: {
    anchorKey: string;
    /** La fonte che ha il dubbio: la domanda nasce solo se è fra le scelte (la stessa del blocco). */
    onlyWith: string;
    fact: Pick<ProductFact, "id" | "change" | "options" | "recommended">;
  }[];
}

/**
 * La prima versione di Claude in uno spazio Prodotto (11b, Task 6). Claude
 * scrive l'albero pagina per pagina per conto di chi l'ha chiesta
 * (`byId`); `groupId` lega le revisioni `first_version`. Si annulla tutta
 * insieme (`undone`), finché nessuno ha toccato una pagina.
 */
export interface ProductFirstVersion {
  projectId: string;
  groupId: string;
  byId: string;
  status: "writing" | "done" | "undone";
  pagesDone: number;
  pagesTotal: number;
  sources: FirstVersionSourceRef[];
  acceptedPageIds: string[];
  /** Le pagine della bozza, nell'ordine dell'albero (titolo e profondità). */
  plan: { title: string; depth: number }[];
  /**
   * Le pagine create, nell'ordine di `plan`, con la revisione da cui si
   * misura «toccata dopo»: quella `first_version` (o la `create`, se la
   * scrittura del corpo non è riuscita).
   */
  written: { pageId: string; revisionId: string }[];
  /** Chi l'ha annullata. */
  undoneById: string | null;
  /** Il copione si è fermato prima della fine (una pagina tolta, `docs.edit` perso). */
  interrupted: boolean;
}

/**
 * La prima versione come la legge chi guarda (11b, Task 6): le fonti nella
 * forma di `sourceViewOf`, le pagine con il loro stato, le pagine che hanno
 * ancora la riga in cima, «Annulla» già deciso. La pagina non ricalcola
 * niente.
 */
export interface ProductFirstVersionView {
  projectId: string;
  groupId: string;
  byId: string;
  /** Chi l'ha chiesta, se chi guarda la vede (`null` altrimenti). */
  byName: string | null;
  status: ProductFirstVersion["status"];
  pagesDone: number;
  pagesTotal: number;
  interrupted: boolean;
  sources: ProductSourceView[];
  pages: {
    title: string;
    depth: number;
    pageId: string | null;
    code: string | null;
    state: "written" | "writing" | "waiting";
  }[];
  acceptedPageIds: string[];
  /** Le pagine scritte che hanno ancora la riga «First version written by Claude…». */
  bannerPageIds: string[];
  undo: ProductUndoView;
  permissions: { edit: boolean };
}

/** Una domanda di Claude ancora aperta nello spazio («N questions to close»). */
export interface OpenProductQuestion {
  commentId: string;
  pageId: string;
  pageCode: string;
  pageTitle: string;
  quote: string;
}

// --- 11b (Task 8): le letture del riquadro di Claude sulla doc di prodotto ----
// Le legge il motore puro (`ReadApi`), sempre come chi chiede: una pagina che
// non legge non c'è, una fonte che non può aprire si legge come una che non c'è.

/** Una pagina di prodotto che chi chiede legge, col suo permesso di scriverla. */
export interface ProductPanelPage extends ProductPage {
  projectCode: string;
  /** `docs.edit` nel progetto (il permesso dei gesti di Claude sulla doc). */
  canEdit: boolean;
}

/** Un blocco che l'aggiornamento chiesto cambierebbe, in testo semplice. */
export interface ProductUpdateChange {
  kind: "replace" | "insert" | "link_task";
  /** La frase di adesso (`null` per un blocco nuovo). */
  before: string | null;
  after: string;
}

/** «Aggiorna la pagina da questa email o riunione», prima della scheda. */
export type ProductUpdatePreview =
  | {
      ok: true;
      source: { kind: "email" | "meeting"; id: string };
      changes: ProductUpdateChange[];
      /** I fatti che diventerebbero domande (vaghi, o in contrasto). */
      questions: number;
      /** I fatti chiari che aspetterebbero chi scrive nella sezione. */
      waiting: number;
    }
  /** `no_source`: nessuna email o riunione che chi chiede possa aprire (anche una che non vede, R-G5). */
  | { ok: false; reason: "not_found" | "forbidden" | "no_source" | "no_facts" };

/** «Proponi le voci di backlog» da una pagina o da una sua sezione. */
export type ProductBacklogDraft =
  | { ok: true; actions: ProposedAction[]; notes: ProposalNote[] }
  | { ok: false; reason: "not_found" | "forbidden" | "no_section" };

/** «Apri una richiesta» da una domanda di Claude sulla doc. */
export type ProductQuestionRequestDraft =
  | { ok: true; actions: ProposedAction[]; pageCode: string; pageTitle: string }
  | { ok: false; reason: "not_found" | "no_request" }
  | { ok: false; reason: "forbidden"; projectCode: string }
  /** `byName` `null` se chi chiede non vede chi ha risposto. */
  | { ok: false; reason: "already_answered"; byName: string | null; option: ProductAnswerChoice };

/** «Scrivi la prima versione»: le fonti che Claude userebbe, tutte quelle che chi chiede vede. */
export type FirstVersionPlan =
  | { ok: true; sources: FirstVersionSource[] }
  | { ok: false; reason: "not_found" | "forbidden" | "space_not_empty" | "no_sources" };

/** Una pagina cambiata negli ultimi sette giorni, come la legge chi chiede. */
export interface ProductWeekChange {
  pageId: string;
  code: string;
  title: string;
  projectCode: string;
  /** Le revisioni della settimana (le unite contano una volta). */
  changes: number;
  /** Chi ha scritto (id, Claude compreso): i nomi li compone chi legge, per chi legge. */
  byIds: string[];
  /**
   * Le fonti delle modifiche di Claude, come riferimenti: la frase («From the
   * email “…”» o «From an email of …») la compone la lettura dell'evento per
   * ogni lettore (`sourceViewOf`, decisione 1, R-G5), mai il testo salvato.
   */
  sourceRefs: ProductSourceRef[];
}

/**
 * 11b (fix round 1 del Task 8): la risposta «cosa è cambiato questa
 * settimana» come dato, sull'evento `assistant`. Il testo salvato è solo una
 * riserva senza fonti né nomi; chi legge riceve il testo ricomposto per lui
 * (`presentProductClaudeEvent`): solo le pagine che legge, le persone che
 * vede, le fonti come le può leggere. Il dato non esce mai dalla lettura.
 */
export interface ProductWeekAnswer {
  projectCode: string | null;
  rows: Pick<ProductWeekChange, "pageId" | "changes" | "byIds" | "sourceRefs">[];
}

/**
 * 11b (fix round 1): le frasi che «aggiorna da questa email» scriverebbe,
 * sull'azione proposta. Restano nel dato e non escono mai dalla lettura: chi
 * legge riceve il `why` composto per lui — le frasi solo se può aprire la
 * fonte, altrimenti «da un'email di <titolare> · <data>» e quante sono.
 */
export interface ProductUpdatePreviewData {
  changes: ProductUpdateChange[];
  questions: number;
  waiting: number;
}

export type ProductRevisionKind =
  | "create"
  | "edit"
  | "rename"
  | "move"
  // Le ultime tre le scrive il 11b.
  | "undo"
  | "first_version"
  | "answer";

/**
 * Una revisione di una pagina di prodotto. I cambi portano i blocchi interi
 * (`before`/`after` coi segni): un grassetto tolto è un cambio, e il 11b
 * annulla tornando ai segni di prima.
 */
export interface ProductRevision {
  id: string;
  pageId: string;
  /** L'ordine di nascita (`nextSeq()`). */
  seq: number;
  /**
   * L'ordine dell'ULTIMA scrittura che la revisione contiene (ruling P12):
   * una scrittura unita prende un `nextSeq()` nuovo. «Prima/dopo»
   * (`touchedAfter`, la cronologia) si leggono da qui, non da `seq`.
   */
  lastSeq: number;
  at: string;
  /** Chi agisce: la persona (anche quando Claude agisce per lei, 11b) o il Claude collega. */
  actorId: string;
  via?: "claude";
  source?: ProductSourceRef;
  undoOf?: string;
  groupId?: string;
  /** La sessione dell'editor che l'ha scritta: le scritture della stessa sessione si uniscono. */
  sessionId?: string;
  kind: ProductRevisionKind;
  changes: ProductBlockChange[];
  title?: { before: string; after: string };
  parent?: { beforeId: string | null; afterId: string | null };
}

/** Chi segue una pagina: solo chi la crea e chi preme «Follow» (maintainer, 5 nov 2026). */
export interface ProductFollow {
  pageId: string;
  personId: string;
  since: string;
}

/**
 * I passi dei copioni del seme (una persona che entra in una pagina, scrive
 * un paragrafo e se ne va). Il tipo è del 11a (ruling P11): il seme lo
 * dichiara, il Task 5 lo esegue. L'id del blocco di un `insert` sta FUORI
 * da `productBlockIds`, altrimenti la scrittura darebbe `block_id_taken`.
 */
export type ProductScriptStep =
  | { step: "enter"; personId: string; anchorId: string | null }
  | { step: "insert"; personId: string; afterId: string; blockId: string }
  | { step: "type"; personId: string; anchorId: string; text: string }
  | { step: "leave"; personId: string };

/**
 * Chi è in una pagina di prodotto adesso (area 11a, Task 5). Una riga per
 * persona e pagina; ogni cambio prende un `nextSeq()` nuovo (mai l'orologio).
 */
export interface ProductPresence {
  pageId: string;
  personId: string;
  /** Dove scrive; `null` = c'è ma non scrive. */
  anchorId: string | null;
  offset: number;
  selection: [number, number] | null;
  seq: number;
}

export interface ProductPresenceView extends ProductPresence {
  name: string;
  initials: string;
  /** Uno dei colori della presenza (`--presence-1`…`--presence-6`), stabile per persona. */
  color: 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Cosa è cambiato in una pagina, per chi è iscritto: il corpo (o titolo e
 * posto), la presenza, i commenti, o la pagina che non c'è più.
 */
export type ProductPageEvent = "blocks" | "presence" | "comments" | "gone";

export interface ProductSpaceView {
  projectId: string;
  projectCode: string;
  tree: ProductTreeNode[];
  pageCount: number;
  /** Aggiornate di recente (al più 5). */
  recent: ProductPageRef[];
  permissions: { edit: boolean };
}

/**
 * Quello che si esporta (Task 12, ruling P20): le pagine nell'ordine
 * dell'albero con la profondità, e i file del Drive e le decisioni citati,
 * già risolti per chi esporta (`null` = non li vede: nessun nome né titolo,
 * R-G5). Le frasi («File: …») le compone la pagina, in en o it, a lettura.
 */
export interface ProductExportView {
  projectCode: string;
  pages: { page: ProductPage; depth: number }[];
  files: Record<string, { name: string } | null>;
  decisions: Record<string, { title: string } | null>;
  /**
   * 11b (P36): l'SVG di ogni bozza di schermata, per `<wireframeId>:<variant>`
   * (`wireframeKey`); `null` = un disegno che il seme non ha più.
   * Facoltativo: un'esportazione senza bozze può non averlo.
   */
  wireframes?: Record<string, string | null>;
}

export interface ProductPageView extends ProductPage {
  /** Gli antenati, dalla radice al genitore. */
  breadcrumbs: ProductPageRef[];
  permissions: { edit: boolean; delete: boolean; deleteBlocked: "has_children" | null };
  following: boolean;
  /** Le decisioni citate, risolte per chi legge; `null` = non visibile (R-G5). */
  decisions: Record<
    string,
    {
      title: string;
      decidedAt: string;
      decidedByName: string | null;
      /** Il progetto della decisione (il suo registro); facoltativo: cambio additivo. */
      projectCode?: string;
    } | null
  >;
  /** I fili aperti della pagina (radici non risolte, con l'ancora viva o no), per la barra. */
  openComments: number;
  /**
   * Chi segue la pagina e la legge, fra le persone che chi guarda vede (P33,
   * R-G5): il `title` di «Follow». Facoltativo: cambio additivo.
   */
  followers?: { id: string; name: string }[];
  /**
   * L'ultima revisione (chi e quando, Task 10): la riga «Updated … by …» la
   * legge da qui, così non afferma una modifica che la cronologia non
   * mostra (uno spostamento di soli blocchi aggiorna `updatedAt` senza
   * revisione). `null` = nessuna revisione; facoltativo: cambio additivo.
   */
  lastRevision?: { at: string; actorId: string } | null;
  /**
   * 11b (Task 7): l'SVG di ogni bozza di schermata della pagina, per
   * `<wireframeId>:<variant>`; `null` = un disegno che il seme non ha più
   * («This sketch is no longer available»). Le pagine non leggono il seme.
   * Facoltativo: cambio additivo.
   */
  wireframes?: Record<string, string | null>;
}

export interface ProductRevisionView extends ProductRevision {
  actorName: string;
  /**
   * 11b (Task 3), tutti facoltativi. `source` e `via` ci sono già (dalla
   * revisione): la fonte vista da chi guarda è `sourceView` (P2).
   */
  sourceView?: ProductSourceView;
  /** Il titolare per cui Claude ha agito; assente per il Claude collega e per le persone. */
  onBehalfOfId?: string;
  /** Solo le modifiche di Claude (`via: "claude"`, `kind: "edit"`): «Annulla» / «Annulla tutto». */
  undo?: ProductUndoView;
  /** Lo stato di ogni ancora cambiata, nella riga aperta. */
  undoByAnchor?: Record<string, ProductUndoView>;
  /** Quante ancore sono già state annullate, su quante («1 di 3 annullate»). */
  undoneCount?: { done: number; count: number };
  /** L'ultimo che ne ha annullato una parte, se chi guarda lo vede. */
  undoneById?: string;
  /** La revisione è la risposta «Aggiorna così» a una domanda di Claude: l'id del filo (P19). */
  answerOf?: string;
  /**
   * 11b (Task 7): la revisione è un gesto sulla bozza di schermata —
   * disegnata o rifatta da Claude, tenuta da una persona («Tieni») o
   * sostituita con un'immagine. Derivato a lettura dai cambi.
   */
  wireframe?: "drew" | "redrew" | "kept" | "replaced";
}

/**
 * Un commento di una pagina di prodotto (area 11a, Task 4). È ancorato a un
 * blocco o a una cella (decisione 4), non a un intervallo di caratteri: la
 * `quote` è la memoria di cosa si guardava, e resta com'era quando l'ancora
 * cambia, si unisce a un'altra (Q3) o sparisce.
 */
export interface ProductComment {
  id: string;
  pageId: string;
  /** L'id d'ancora (blocco o cella). */
  anchorId: string;
  /** La frase scelta al momento del commento (≤ 200): resta anche se l'ancora sparisce. */
  quote: string;
  authorId: string;
  body: string;
  createdAt: string;
  seq: number;
  /** Risposte in fila: solo a una radice. */
  replyToId: string | null;
  /** Solo la radice. */
  resolved: { byId: string; at: string } | null;
  /** Chi il testo menziona e leggeva i Docs del progetto quando è stato scritto; mai chi scrive. */
  mentionIds: string[];
  /** 11b: la radice è una domanda di Claude (`askProductQuestion`). Facoltativo. */
  question?: ProductQuestion;
}

export interface ProductCommentView extends Omit<ProductComment, "question"> {
  authorName: string;
  /** 11b: la domanda di Claude come la legge chi guarda (mai la fonte grezza). */
  question?: ProductQuestionView;
}

export interface ProductCommentThread {
  root: ProductCommentView;
  replies: ProductCommentView[];
  /** L'ancora non c'è più: «Frase eliminata». Derivato a lettura. */
  anchorGone: boolean;
}
