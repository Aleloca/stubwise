import { z } from "zod";
import { effortSchema, ticketPrioritySchema } from "./ticket.js";

/**
 * Ciclo di vita di una voce del backlog di discovery: `new` (appena intaccata,
 * in attesa di intake), `refining` (in raffinamento via chat), `ready` (pronta
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
 * metadati suggeriti), `deep_dive` (approfondimento sul repo collegato) o
 * `chat_turn` (un turno della sessione di analisi sul codice: il worker investiga
 * il repo in diretta via claude CLI e risponde in chat).
 */
export const backlogJobKindSchema = z.enum(["intake", "deep_dive", "chat_turn", "estimate"]);
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

/** Payload di un job `deep_dive`: la voce da approfondire e il repo scelto. */
export const backlogDeepDivePayloadSchema = z
  .object({ itemId: z.uuid(), repositoryId: z.uuid() })
  .strict();
export type BacklogDeepDivePayload = z.infer<typeof backlogDeepDivePayloadSchema>;

/**
 * Payload di un job `chat_turn`: la voce, l'id del messaggio utente che ha
 * innescato il turno e la SESSIONE di analisi in cui è stato posto. Il worker
 * risponde in QUELLA sessione (repo, cli_session_id), non nell'eventuale
 * sessione attiva al momento del dequeue: una chiusura+riapertura su un altro
 * repo nel frattempo non devia la risposta. Il CONTENUTO della domanda vive nel
 * messaggio persistito (`backlog_chat_messages`), non nel payload.
 */
export const backlogChatTurnPayloadSchema = z
  .object({ itemId: z.uuid(), userMessageId: z.uuid(), sessionId: z.uuid() })
  .strict();
export type BacklogChatTurnPayload = z.infer<typeof backlogChatTurnPayloadSchema>;

/** Payload di un job `estimate`: la voce di backlog da stimare a partire dal design. */
export const backlogEstimatePayloadSchema = z.object({ itemId: z.uuid() }).strict();
export type BacklogEstimatePayload = z.infer<typeof backlogEstimatePayloadSchema>;

/**
 * Union discriminata-per-forma del payload di QUALSIASI job del backlog: intake
 * (da ticket o manuale), deep_dive o chat_turn. Applicata come `.$type<>` sulla
 * colonna `payload` di `backlog_jobs` e validata al dequeue dal worker (un
 * payload che non combacia con nessuna forma → job fallito subito, senza retry).
 * La discriminazione resta per FORMA, non per `kind`: `deep_dive` è
 * `{itemId, repositoryId}` e `chat_turn` è `{itemId, userMessageId, sessionId}`,
 * forme distinte grazie a `.strict()`.
 */
export const backlogJobPayloadSchema = z.union([
  backlogIntakeFromTicketPayloadSchema,
  backlogIntakeManualPayloadSchema,
  backlogDeepDivePayloadSchema,
  backlogChatTurnPayloadSchema,
  backlogEstimatePayloadSchema,
]);
export type BacklogJobPayload = z.infer<typeof backlogJobPayloadSchema>;

/**
 * Stato di una sessione di analisi sul codice: `active` (aperta, i messaggi
 * della chat diventano turni dell'agente sul repo) o `closed` (chiusa a mano o
 * scaduta per inattività). L'enum Postgres deriva da questo schema.
 */
export const backlogCodeSessionStatusSchema = z.enum(["active", "closed"]);
export type BacklogCodeSessionStatus = z.infer<typeof backlogCodeSessionStatusSchema>;

/**
 * Input per avviare una sessione di analisi sul codice: il repository su cui
 * l'agente investigherà (deve appartenere al progetto della voce).
 */
export const startCodeSessionSchema = z.object({ repositoryId: z.uuid() }).strict();
export type StartCodeSessionInput = z.infer<typeof startCodeSessionSchema>;

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
 * Body degli endpoint che impostano un campo di CONTENUTO libero (design doc o
 * piano di implementazione) su una voce di backlog o su un ticket: un testo non
 * vuoto entro il tetto dei corpi lunghi. Condiviso tra le quattro superfici
 * (design/piano × backlog/ticket) perché la forma del payload è identica.
 */
export const setContentSchema = z.object({ content: z.string().min(1).max(200_000) });
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

/**
 * Autore di un messaggio della chat di raffinamento. `system` copre i marker
 * automatici (es. l'esito di un deep dive), che non hanno né un umano né
 * l'assistente dietro. La colonna `backlog_chat_messages.role` deriva da qui.
 */
export const backlogMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type BacklogMessageRole = z.infer<typeof backlogMessageRoleSchema>;

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
 * e il nucleo del dettaglio, che vi aggiunge `tickets` e `messages`.
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

/** Messaggio della chat di raffinamento (una sola conversazione per voce). */
export const backlogMessageSchema = z.object({
  id: z.uuid(),
  role: backlogMessageRoleSchema,
  content: z.string(),
  // Citazioni RAG dell'assistant (jsonb opaco), null se assenti.
  citations: z.unknown().nullable(),
  createdAt: z.iso.datetime(),
});
export type BacklogMessage = z.infer<typeof backlogMessageSchema>;

/**
 * Sessione di analisi sul codice ATTIVA di una voce (o null). In modalità code
 * ogni messaggio della chat diventa un turno dell'agente sul repo. Espone lo
 * stretto necessario alla UI: stato, repo su cui investiga e istante d'avvio.
 */
export const backlogCodeSessionSchema = z.object({
  status: backlogCodeSessionStatusSchema,
  repositoryId: z.uuid(),
  startedAt: z.iso.datetime(),
});
export type BacklogCodeSession = z.infer<typeof backlogCodeSessionSchema>;

/**
 * DETTAGLIO di una voce: la forma base più i ticket collegati, i messaggi di
 * chat e i flag di lavorazione in corso.
 */
export const backlogItemDetailSchema = backlogItemBaseSchema.extend({
  tickets: z.array(backlogLinkedTicketSchema),
  messages: z.array(backlogMessageSchema),
  // True se esiste un job deep_dive queued/running per la voce (UI: "analisi in
  // corso" con polling).
  deepDivePending: z.boolean(),
  // Sessione di analisi sul codice attiva (o null): la chat è in modalità code.
  codeSession: backlogCodeSessionSchema.nullable(),
  // True se esiste un job chat_turn queued/running per la voce (UI: "sta
  // investigando nel codice…" con polling).
  pendingTurn: z.boolean(),
});
export type BacklogItemDetail = z.infer<typeof backlogItemDetailSchema>;

/** Pagina della lista backlog: gemella di `ticketPageSchema`. */
export const backlogPageSchema = z.object({
  items: z.array(backlogItemSchema),
  nextCursor: z.string().nullable(),
});
export type BacklogPage = z.infer<typeof backlogPageSchema>;
