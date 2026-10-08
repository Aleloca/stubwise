import { z } from "zod";

/**
 * Sessioni degli agenti (design 2026-10-08-agent-sessions-design.md).
 *
 * Una SESSIONE è l'unità di lavoro che l'utente riconosce (un job, una review,
 * una voce di backlog…), fatta di uno o più SEGMENTI: ogni segmento è un
 * processo `claude`. Gli eventi sono la trascrizione normalizzata dal worker.
 *
 * Forward-compat verso l'app (che parsa con `readerSchema`): ogni campo che
 * può mancare in un server più vecchio nasce `.default()`/`.nullable()`, e
 * `data` di un evento è un record aperto — un tipo di evento nuovo arriva come
 * `UNKNOWN` e il client semplicemente non lo disegna.
 */

export const agentSessionKindSchema = z.enum([
  "ai_job",
  "pr_review",
  "backlog_item",
  "backlog_job",
  "doc_generation",
  "email_message",
  "project_brief",
  "daily_report",
]);
export type AgentSessionKind = z.infer<typeof agentSessionKindSchema>;

export const agentSegmentLabelSchema = z.enum([
  "triage",
  "plan",
  "plan_resume",
  "execute",
  "self_repair",
  "correction",
  "correction_self_repair",
  "review",
  "plan_summary",
  "failure_summary",
  "pr_summary",
  "deep_dive",
  "chat_turn",
  "intake",
  "estimate",
  "email_classify",
  "docs",
  "brief",
  "daily_report",
]);
export type AgentSegmentLabel = z.infer<typeof agentSegmentLabelSchema>;

/**
 * Segmenti su cui un maintainer può scrivere. Elenco ESPLICITO: un segmento
 * nuovo non diventa interattivo da solo (spec §6.4).
 *
 * `docs` NON c'è, di proposito (v1, design §12 H3): i nodi di una generazione
 * girano in parallelo nella stessa sessione e un intervento non saprebbe a
 * quale processo andare. Si guarda e basta.
 */
export const INTERACTIVE_SEGMENTS: ReadonlySet<AgentSegmentLabel> = new Set<AgentSegmentLabel>([
  "plan",
  "plan_resume",
  "execute",
  "self_repair",
  "correction",
  "correction_self_repair",
  "review",
  "deep_dive",
  "chat_turn",
]);

/**
 * Canali di `pg_notify` fra worker e server. UNA definizione: un refuso in una
 * copia spegnerebbe lo stream dal vivo senza un errore.
 * - eventi: payload `{ sessionId }` (gli eventi si rileggono dalla tabella);
 * - parziali: payload `{ sessionId, segmentId, text }` (mai salvati);
 * - input: payload `{ sessionId }`, dal server al worker.
 */
export const AGENT_SESSION_EVENTS_CHANNEL = "agent_session_events";
export const AGENT_SESSION_PARTIAL_CHANNEL = "agent_session_partial";
export const AGENT_SESSION_INPUT_CHANNEL = "agent_session_input";

export const agentSessionEventTypeSchema = z.enum([
  "segment_start",
  "assistant_text",
  "tool_use",
  "tool_result",
  "input",
  "turn_end",
  "segment_end",
]);
export type AgentSessionEventType = z.infer<typeof agentSessionEventTypeSchema>;

/**
 * `data` per tipo (record aperto: un campo in più non rompe nessuno):
 * - `input`: `{ text, interrupt, inputId, authorUserId }` scritti dal worker,
 *   più `authorName` DERIVATO dal server a lettura (email, o null);
 * - `segment_start`: `{ label, interactive }`; `segment_end`: `{ exitCode, timedOut }`;
 * - `tool_use`: `{ toolUseId, name, input }`; `tool_result`: `{ toolUseId, isError, content, truncated? }`;
 * - `assistant_text`: `{ text }`; `turn_end`: `{ subtype, isError, costUsd }`.
 */
export const agentSessionEventSchema = z.object({
  /** bigserial come stringa: è anche il cursore di paginazione. */
  id: z.string(),
  type: agentSessionEventTypeSchema,
  segmentId: z.string(),
  at: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type AgentSessionEvent = z.infer<typeof agentSessionEventSchema>;

/**
 * Stato DERIVATO a lettura dal server (regola in
 * `apps/server/src/services/agent-sessions.ts`, `deriveAgentSessionState`):
 * - working: un segmento vivo, oppure il lavoro proprietario è in corso fra
 *   due segmenti (job in triage/fix, review/generazione/job di backlog running);
 * - waiting_input: il job è fermo su una domanda (o la voce ha una domanda aperta);
 * - awaiting_approval: il piano aspetta l'approvazione di un maintainer;
 * - held: il job è parcheggiato (limite, budget, gate) o la generazione Docs è in pausa;
 * - queued: job, generazione Docs o job di backlog in coda;
 * - ended: nient'altro.
 */
export const agentSessionStateSchema = z.enum([
  "queued",
  "working",
  "waiting_input",
  "awaiting_approval",
  "held",
  "ended",
]);
export type AgentSessionState = z.infer<typeof agentSessionStateSchema>;

/**
 * Esito DERIVATO a lettura, mai scritto (design §8.2). Solo per `state:
 * "ended"`; `null` quando non si sa. Fonte: lo stato della riga proprietaria
 * (job, review, generazione Docs, job di backlog) o, se non c'è, l'ultimo
 * `segment_end`. Vedi `deriveAgentSessionOutcome` sul server.
 */
export const agentSessionOutcomeSchema = z.enum(["completed", "failed", "skipped"]);
export type AgentSessionOutcome = z.infer<typeof agentSessionOutcomeSchema>;

export const agentActivitySchema = z.object({
  kind: z.enum(["edit", "read", "run", "search", "web", "ask", "subagent", "write", "other"]),
  target: z.string().nullable(),
});

export const agentSessionSummarySchema = z.object({
  id: z.string().uuid(),
  kind: agentSessionKindSchema,
  title: z.string(),
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
  ticketId: z.string().uuid().nullable(),
  ticketNumber: z.number().int().nullable(),
  startedAt: z.string(),
  lastEventAt: z.string().nullable(),
  state: agentSessionStateSchema,
  activeSegment: agentSegmentLabelSchema.nullable().default(null),
  lastActivity: agentActivitySchema.nullable().default(null),
  /** Il job AI proprietario: serve a «Guarda la sessione» dal ticket e dalle notifiche. */
  aiJobId: z.string().uuid().nullable().default(null),
  outcome: agentSessionOutcomeSchema.nullable().default(null),
});
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>;

export const agentSessionListSchema = z.object({
  live: z.array(agentSessionSummarySchema),
  recent: z.array(agentSessionSummarySchema),
});

/** `GET /api/agent-sessions?projectId=&ticketId=&aiJobId=` (tutti facoltativi, in AND). */
export const agentSessionListQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  ticketId: z.string().uuid().optional(),
  aiJobId: z.string().uuid().optional(),
});
export type AgentSessionListQuery = z.infer<typeof agentSessionListQuerySchema>;

export const agentInputStatusSchema = z.enum(["pending", "delivered", "undelivered"]);
export type AgentInputStatus = z.infer<typeof agentInputStatusSchema>;
export const agentInputReasonSchema = z.enum(["session_not_live", "stdin_closed"]);
export type AgentInputReason = z.infer<typeof agentInputReasonSchema>;

/**
 * Un intervento di un maintainer (riga di `agent_session_inputs`). Serve a
 * mostrare anche quelli NON consegnati (design §6.2: mai persi in silenzio).
 * `authorName` è DERIVATO a lettura come per gli autori dei commenti:
 * l'email dell'utente, `null` se non esiste più.
 */
export const agentSessionInputSchema = z.object({
  id: z.string().uuid(),
  text: z.string(),
  status: agentInputStatusSchema,
  reason: agentInputReasonSchema.nullable(),
  authorUserId: z.string().uuid().nullable(),
  authorName: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type AgentSessionInput = z.infer<typeof agentSessionInputSchema>;

export const agentSessionQuestionSchema = z.object({
  id: z.string().uuid(),
  source: z.enum(["agent", "backlog"]),
  question: z.string(),
  askedAt: z.string(),
  answered: z.boolean(),
});

export const agentSessionDetailSchema = agentSessionSummarySchema.extend({
  /** Calcolato dal server col ruolo di chi guarda: mai dedotto dal client. */
  canWrite: z.boolean().default(false),
  /** Il CLI del segmento vivo dichiara l'interruzione fra le capabilities. */
  canInterrupt: z.boolean().default(false),
  questions: z.array(agentSessionQuestionSchema).default([]),
  /** Interventi della sessione, consegnati o no, in ordine di creazione. */
  inputs: z.array(agentSessionInputSchema).default([]),
});
export type AgentSessionDetail = z.infer<typeof agentSessionDetailSchema>;

export const agentSessionEventPageSchema = z.object({
  events: z.array(agentSessionEventSchema),
  /** Cursore per la pagina PRECEDENTE (eventi più vecchi), null se finita. */
  before: z.string().nullable(),
});

export const sendAgentMessageInputSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  interrupt: z.boolean().default(false),
});
export type SendAgentMessageInput = z.infer<typeof sendAgentMessageInputSchema>;

export const sendAgentMessageResultSchema = z.object({
  inputId: z.string().uuid(),
  status: agentInputStatusSchema,
});
