import { z } from "zod";
import { effortSchema, ticketPrioritySchema } from "./ticket.js";

/**
 * Ciclo di vita di una voce del backlog di discovery: `new` (appena intaccata,
 * in attesa di intake), `refining` (in raffinamento in una sessione), `ready` (pronta
 * alla conversione in ticket), `converted` (già trasformata in ticket) o
 * `archived` (scartata). L'enum Postgres deriva da questo schema: valori e
 * validazione non possono divergere.
 */
export const backlogItemStatusSchema = z.enum([
  "new",
  "refining",
  "ready",
  "converted",
  "archived",
]);
export type BacklogItemStatus = z.infer<typeof backlogItemStatusSchema>;

/** Livello di rischio stimato per l'implementazione di una voce del backlog. */
export const backlogRiskSchema = z.enum(["low", "medium", "high"]);
export type BacklogRisk = z.infer<typeof backlogRiskSchema>;

/** L'urgenza riusa la scala di priority dei ticket (low/medium/high/urgent). */
export const backlogUrgencySchema = ticketPrioritySchema;

/** Origine di una voce del backlog: deviata da un ticket o creata a mano. */
export const backlogItemSourceSchema = z.enum(["ticket", "manual"]);
export type BacklogItemSource = z.infer<typeof backlogItemSourceSchema>;

/**
 * Tipo di job del backlog: `intake` (prima elaborazione di una voce: dedup +
 * metadati suggeriti) o `estimate` (stima della voce a partire dal design).
 * `deep_dive` e `chat_turn` sono stati dismessi il 19 ott 2026 con la chat
 * della voce: la migrazione 0091 ha ricreato l'enum Postgres con questi due
 * soli valori, nello stesso ordine.
 */
export const backlogJobKindSchema = z.enum(["intake", "estimate"]);
export type BacklogJobKind = z.infer<typeof backlogJobKindSchema>;

/** Stato di un job del backlog nella coda del worker. */
export const backlogJobStatusSchema = z.enum(["queued", "running", "done", "failed"]);
export type BacklogJobStatus = z.infer<typeof backlogJobStatusSchema>;

/**
 * Payload di un job `intake` DEVIATO DA UN TICKET: solo il riferimento al ticket.
 * Titolo e corpo vengono letti dal ticket al dequeue (fonte di verità sempre
 * fresca, niente copia stantia nel payload).
 */
export const backlogIntakeFromTicketPayloadSchema = z.object({ ticketId: z.uuid() }).strict();
export type BacklogIntakeFromTicketPayload = z.infer<typeof backlogIntakeFromTicketPayloadSchema>;

/**
 * Payload di un job `intake` MANUALE (idea proposta da un utente senza ticket):
 * titolo e corpo sono nel payload, non c'è un ticket d'origine.
 */
export const backlogIntakeManualPayloadSchema = z
  .object({ title: z.string().min(1), body: z.string().min(1) })
  .strict();
export type BacklogIntakeManualPayload = z.infer<typeof backlogIntakeManualPayloadSchema>;

/**
 * Payload di un job `intake`, in una delle due FORME (da ticket o manuale). La
 * discriminazione è per FORMA, non per `kind` (entrambe hanno kind `intake`):
 * `z.union` di oggetti `strict`, così `{ticketId}` e `{title, body}` non si
 * confondono né tollerano campi estranei.
 */
export const backlogIntakePayloadSchema = z.union([
  backlogIntakeFromTicketPayloadSchema,
  backlogIntakeManualPayloadSchema,
]);
export type BacklogIntakePayload = z.infer<typeof backlogIntakePayloadSchema>;

/** Payload di un job `estimate`: la voce di backlog da stimare a partire dal design. */
export const backlogEstimatePayloadSchema = z.object({ itemId: z.uuid() }).strict();
export type BacklogEstimatePayload = z.infer<typeof backlogEstimatePayloadSchema>;

/**
 * Union discriminata-per-forma del payload di QUALSIASI job del backlog: intake
 * (da ticket o manuale) o estimate. Applicata come `.$type<>` sulla colonna
 * `payload` di `backlog_jobs` e validata al dequeue dal worker (un payload che
 * non combacia con nessuna forma → job fallito subito, senza retry). La
 * discriminazione resta per FORMA, non per `kind`: le tre forme sono distinte
 * grazie a `.strict()`.
 */
export const backlogJobPayloadSchema = z.union([
  backlogIntakeFromTicketPayloadSchema,
  backlogIntakeManualPayloadSchema,
  backlogEstimatePayloadSchema,
]);
export type BacklogJobPayload = z.infer<typeof backlogJobPayloadSchema>;

/**
 * Metadati suggeriti dall'AI in attesa di conferma umana. Restano separati dai
 * campi confermati sulla voce (effort/risk/urgency): l'umano li promuove
 * esplicitamente durante il raffinamento.
 */
export const backlogSuggestedSchema = z.object({
  effort: effortSchema.optional(),
  risk: backlogRiskSchema.optional(),
  riskNote: z.string().max(2000).optional(),
  urgency: backlogUrgencySchema.optional(),
  reason: z.string().max(2000).optional(),
});
export type BacklogSuggested = z.infer<typeof backlogSuggestedSchema>;

/**
 * Aggiornamento parziale di una voce del backlog. I campi valorizzabili sono
 * nullable (per azzerarli) e opzionali (per non toccarli).
 */
export const updateBacklogItemSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  status: backlogItemStatusSchema.optional(),
  effort: effortSchema.nullable().optional(),
  risk: backlogRiskSchema.nullable().optional(),
  riskNote: z.string().max(2000).nullable().optional(),
  urgency: backlogUrgencySchema.nullable().optional(),
});
export type UpdateBacklogItemInput = z.infer<typeof updateBacklogItemSchema>;

/**
 * Tetto di design e piano, UNA volta sola: le rotte (`setContentSchema`) e i
 * tool di scrittura delle sessioni di refinement (`backlog-refine.ts`, che lo
 * ri-esporta) non possono divergere.
 */
export const REFINE_DOC_MAX_CHARS = 200_000;

/**
 * Body degli endpoint che impostano un campo di CONTENUTO libero (design doc o
 * piano di implementazione) su una voce di backlog o su un ticket: un testo non
 * vuoto entro il tetto dei corpi lunghi. Condiviso tra le quattro superfici
 * (design/piano × backlog/ticket) perché la forma del payload è identica.
 */
export const setContentSchema = z.object({ content: z.string().min(1).max(REFINE_DOC_MAX_CHARS) });
export type SetContentInput = z.infer<typeof setContentSchema>;

/** Creazione manuale di una voce del backlog (non deviata da un ticket). */
export const createBacklogItemSchema = z.object({
  projectId: z.uuid(),
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
});
export type CreateBacklogItemInput = z.infer<typeof createBacklogItemSchema>;

/**
 * Creazione di una voce del backlog A PARTIRE DA UN DESIGN GIÀ PRONTO: il testo
 * del design è il contenuto (fino al tetto dei corpi lunghi), da cui il worker
 * ricava titolo e stime. Deviazione dal percorso di intake standard.
 */
export const createBacklogFromDesignSchema = z.object({
  projectId: z.uuid(),
  title: z.string().min(1).max(300),
  design: z.string().min(1).max(200_000),
});
export type CreateBacklogFromDesignInput = z.infer<typeof createBacklogFromDesignSchema>;

/**
 * Ruolo del legame voce↔ticket: `origin` (il ticket ha originato la voce) o
 * `converted_to` (la voce è stata convertita in questo ticket). L'enum Postgres
 * deriva da questo schema.
 */
export const backlogTicketRoleSchema = z.enum(["origin", "converted_to"]);
export type BacklogTicketRole = z.infer<typeof backlogTicketRoleSchema>;

/** Riferimento a una voce simile suggerita dal dedup (o null). */
export const backlogSimilarRefSchema = z.object({ id: z.uuid(), title: z.string() });
export type BacklogSimilarRef = z.infer<typeof backlogSimilarRefSchema>;

/**
 * Voce del backlog nella LISTA: campi leggeri per le card. Volutamente SENZA
 * `document` né `embedding` (payload pesanti inutili in lista).
 */
export const backlogItemSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  title: z.string(),
  status: backlogItemStatusSchema,
  effort: z.number().int().nullable(),
  risk: backlogRiskSchema.nullable(),
  riskNote: z.string().nullable(),
  urgency: backlogUrgencySchema.nullable(),
  requestCount: z.number().int(),
  source: backlogItemSourceSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  similarTo: backlogSimilarRefSchema.nullable(),
  ticketCount: z.number().int(),
});
export type BacklogItem = z.infer<typeof backlogItemSchema>;

/**
 * Forma "base" della voce: tutti i campi confermati più `document`, `suggested`
 * e `similarTo` risolto (SENZA `embedding`). È la risposta di PATCH/accept/dismiss
 * e il nucleo del dettaglio, che vi aggiunge `tickets` e `refineSession`.
 */
export const backlogItemBaseSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  title: z.string(),
  document: z.string(),
  // Piano di implementazione e contenuto d'origine (design/piano collegati alla
  // voce): testo libero, null finché non impostati.
  implementationPlan: z.string().nullable(),
  originContent: z.string().nullable(),
  status: backlogItemStatusSchema,
  effort: z.number().int().nullable(),
  risk: backlogRiskSchema.nullable(),
  riskNote: z.string().nullable(),
  urgency: backlogUrgencySchema.nullable(),
  requestCount: z.number().int(),
  source: backlogItemSourceSchema,
  suggested: backlogSuggestedSchema.nullable(),
  similarTo: backlogSimilarRefSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BacklogItemBase = z.infer<typeof backlogItemBaseSchema>;

/** Ticket collegato a una voce (join backlog_item_tickets → tickets). */
export const backlogLinkedTicketSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  role: backlogTicketRoleSchema,
});
export type BacklogLinkedTicket = z.infer<typeof backlogLinkedTicketSchema>;

/**
 * Sessione di refinement di una voce (design 2026-10-14): UNA per voce, continua
 * nel tempo (si chiude per inattività o a mano, e si riprende). La sessione vera
 * è quella dell'agente (`agentSessionId`): qui solo ciò che serve alla pagina
 * della voce per mostrare «Inizia / Riprendi / pronta / al lavoro».
 */
export const refineSessionStatusSchema = z.enum(["active", "closed"]);
export type RefineSessionStatus = z.infer<typeof refineSessionStatusSchema>;
export const refineCloseReasonSchema = z.enum(["user", "idle", "item_closed"]);
export type RefineCloseReason = z.infer<typeof refineCloseReasonSchema>;
export const refineSessionViewSchema = z.object({
  agentSessionId: z.uuid(),
  status: refineSessionStatusSchema,
  closedReason: refineCloseReasonSchema.nullable().default(null),
  lastActivityAt: z.iso.datetime(),
});
export type RefineSessionView = z.infer<typeof refineSessionViewSchema>;

/**
 * DETTAGLIO di una voce: la forma base più i ticket collegati e la sessione di
 * refinement. Chat, sessione di analisi, deep dive e domande a bottoni (con i
 * loro campi `messages`, `deepDivePending`, `codeSession`, `pendingTurn`,
 * `openQuestion`) sono stati dismessi il 19 ott 2026.
 */
export const backlogItemDetailSchema = backlogItemBaseSchema.extend({
  tickets: z.array(backlogLinkedTicketSchema),
  // Sessione di refinement (2026-10-14), o null. Additivo: un server più
  // vecchio non lo manda, e l'app lo legge come null.
  refineSession: refineSessionViewSchema.nullable().default(null),
});
export type BacklogItemDetail = z.infer<typeof backlogItemDetailSchema>;

/** Pagina della lista backlog: gemella di `ticketPageSchema`. */
export const backlogPageSchema = z.object({
  items: z.array(backlogItemSchema),
  nextCursor: z.string().nullable(),
  /**
   * Quante voci soddisfano i FILTRI della richiesta — gemello esatto di
   * `ticketPageSchema.total`, cursore escluso e `.optional()` per le stesse
   * ragioni: vedi il docblock là.
   */
  total: z.number().int().optional(),
});
export type BacklogPage = z.infer<typeof backlogPageSchema>;

/**
 * Esito (202) della creazione manuale di una voce. `queued: true` e non un id:
 * la rotta NON crea la voce, accoda un job di intake — è quello a deciderne
 * forma e stima, e a volte a FONDERLA in una voce esistente invece di crearne
 * una nuova. `jobId` è il job accodato.
 */
export const createBacklogResultSchema = z.object({
  queued: z.literal(true),
  jobId: z.uuid(),
});
export type CreateBacklogResult = z.infer<typeof createBacklogResultSchema>;

/**
 * Stato di un job del backlog (`GET /api/backlog/jobs/:jobId`): serve a chi ha
 * accodato un intake per sapere quando la voce esiste davvero. `resultItemId`
 * è la voce creata, o quella in cui l'intake l'ha fusa.
 */
export const backlogJobResultSchema = z.object({
  status: backlogJobStatusSchema,
  resultItemId: z.uuid().nullable(),
  error: z.string().nullable(),
});
export type BacklogJobResult = z.infer<typeof backlogJobResultSchema>;

/** Esito della conversione di una voce in ticket: id e numero del ticket nato. */
export const convertBacklogResultSchema = z.object({
  ticketId: z.uuid(),
  ticketNumber: z.number().int(),
});
export type ConvertBacklogResult = z.infer<typeof convertBacklogResultSchema>;
