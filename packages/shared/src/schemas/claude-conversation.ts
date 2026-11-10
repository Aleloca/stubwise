import { z } from "zod";
import { agentSessionDetailSchema, agentSessionStateSchema } from "./agent-session.js";

/**
 * La conversazione libera con Claude (integrazione «Chat con Claude», fetta 1,
 * design `docs/plans/2026-11-10-integrazione-claude-chat-design.md`). È una
 * sessione dell'agente di kind `free` (eventi, messaggi e stream sono quelli
 * delle sessioni), più ciò che le sessioni non hanno: autore, titolo, archivio
 * e contesto della pagina. PRIVATA del suo autore: nessun altro la vede, nemmeno
 * un full admin (le pubbliche sono una fetta a sé). In questa fetta Claude legge
 * e risponde, non propone né esegue niente.
 */

/** Il contesto della pagina da cui nasce (o che le si dà): un oggetto, per tipo e id. */
export const claudeConversationContextSchema = z.object({
  kind: z.string().trim().min(1).max(40),
  id: z.string().trim().min(1).max(200),
});
export type ClaudeConversationContext = z.infer<typeof claudeConversationContextSchema>;

export const CLAUDE_CONVERSATION_TITLE_MAX = 200;
export const CLAUDE_CONVERSATION_MESSAGE_MAX = 4000;

export const claudeConversationSchema = z.object({
  /** L'id della sessione dell'agente: lo stesso per messaggi, eventi e stream. */
  id: z.uuid(),
  /** Dalla prima domanda (un template, mai il modello), rinominabile. */
  title: z.string(),
  archived: z.boolean().default(false),
  context: claudeConversationContextSchema.nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Lo stato DERIVATO della sessione (al lavoro, in coda, ferma). */
  state: agentSessionStateSchema,
  lastEventAt: z.string().nullable().default(null),
});
export type ClaudeConversation = z.infer<typeof claudeConversationSchema>;

export const claudeConversationListSchema = z.object({
  items: z.array(claudeConversationSchema),
  /** Il cursore della pagina dopo (`?before=`); `null` = finite. Default per un server più vecchio. */
  nextCursor: z.string().nullable().default(null),
});

/** Il dettaglio: la conversazione e la sua sessione (permessi, interventi, stato). */
export const claudeConversationDetailSchema = claudeConversationSchema.extend({
  session: agentSessionDetailSchema,
});
export type ClaudeConversationDetail = z.infer<typeof claudeConversationDetailSchema>;

/** `POST /api/claude/conversations`: il primo messaggio (facoltativo) diventa il primo turno. */
export const createClaudeConversationSchema = z.object({
  message: z.string().trim().min(1).max(CLAUDE_CONVERSATION_MESSAGE_MAX).optional(),
  title: z.string().trim().min(1).max(CLAUDE_CONVERSATION_TITLE_MAX).optional(),
  context: claudeConversationContextSchema.nullable().optional(),
});
export type CreateClaudeConversationInput = z.input<typeof createClaudeConversationSchema>;

/** `PATCH /api/claude/conversations/:id`: titolo, archivio, contesto; gli assenti restano. */
export const patchClaudeConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(CLAUDE_CONVERSATION_TITLE_MAX),
    archived: z.boolean(),
    context: claudeConversationContextSchema.nullable(),
  })
  .partial();
export type PatchClaudeConversationInput = z.infer<typeof patchClaudeConversationSchema>;

/** `GET /api/claude/conversations?scope=mine&archived=`: solo le proprie. */
export const claudeConversationListQuerySchema = z.object({
  scope: z.literal("mine").default("mine"),
  archived: z.enum(["true", "false"]).default("false"),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().max(200).optional(),
});

/**
 * `GET /api/claude/status`: ciò che la casella della chat deve sapere prima di
 * scrivere. `budgetExhausted`: il budget AI del mese è finito, quindi né una
 * conversazione nuova né un messaggio partono (409 `budget_exhausted`); la
 * casella si spegne con la sua frase. Nasce con il default, per un server
 * più vecchio che non lo manda.
 */
export const claudeChatStatusSchema = z.object({ budgetExhausted: z.boolean().default(false) });
export type ClaudeChatStatus = z.infer<typeof claudeChatStatusSchema>;

/**
 * Il titolo dalla prima domanda: la prima riga, senza spazi in eccesso,
 * troncata. Un TEMPLATE, mai il modello (titoli e testi automatici non sono
 * scritti dall'AI dove non serve).
 */
export function conversationTitleFrom(message: string, max = 80): string {
  const line = message.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const flat = line.replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Il server MCP dei tool della chat. Le LETTURE (fette 1–3) leggono dal server
 * con il token del turno, cioè come l'autore (rotte di `CHAT_TOOL_READ_ROUTES`
 * del server). Dalla fetta 3 c'è UN tool che scrive, `propose_action`, e
 * scrive solo una PROPOSTA (l'unica voce di `CHAT_TOOL_WRITE_ROUTES`): la
 * classe la calcola il server, una B aspetta la conferma dell'autore. Il CLI
 * li chiama `mcp__<server>__<tool>`.
 */
export const CHAT_MCP_SERVER_NAME = "stubwise_chat";
export const CHAT_READ_TOOLS = [
  "list_projects",
  "list_people",
  "search_tasks",
  "read_task",
  "read_request",
  "search_docs",
  "read_project_overview",
] as const;
export type ChatReadToolName = (typeof CHAT_READ_TOOLS)[number];
/** Il solo tool che non legge: scrive una proposta, mai un'esecuzione diretta. */
export const CHAT_PROPOSE_TOOL = "propose_action" as const;
export const CHAT_TOOLS = [...CHAT_READ_TOOLS, CHAT_PROPOSE_TOOL] as const;
export type ChatToolName = (typeof CHAT_TOOLS)[number];
export const CHAT_TOOL_NAMES: readonly string[] = CHAT_TOOLS.map((tool) => `mcp__${CHAT_MCP_SERVER_NAME}__${tool}`);
