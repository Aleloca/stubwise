import { z } from "zod";
import { agentSessionDetailSchema, agentSessionStateSchema } from "./agent-session.js";

/**
 * La conversazione libera con Claude (integrazione «Chat con Claude», fetta 1,
 * design `docs/plans/2026-11-10-integrazione-claude-chat-design.md`). È una
 * sessione dell'agente di kind `free` (eventi, messaggi e stream sono quelli
 * delle sessioni), più ciò che le sessioni non hanno: autore, titolo, archivio
 * e contesto della pagina. PRIVATA del suo autore: nessun altro la vede, nemmeno
 * un full admin. Dalla fetta 5 l'autore può renderla PUBBLICA: la LEGGE chi ha
 * `claude.public.view` (proiezione del server), nessun altro ci scrive, e chi
 * vuole proseguire la CONTINUA in una conversazione nuova e sua.
 */

/** Il contesto della pagina da cui nasce (o che le si dà): un oggetto, per tipo e id. */
export const claudeConversationContextSchema = z.object({
  kind: z.string().trim().min(1).max(40),
  id: z.string().trim().min(1).max(200),
});
export type ClaudeConversationContext = z.infer<typeof claudeConversationContextSchema>;

export const CLAUDE_CONVERSATION_TITLE_MAX = 200;
export const CLAUDE_CONVERSATION_MESSAGE_MAX = 4000;

/** Un progetto come lo vede chi guarda: codice e nome (solo i visibili). */
export const claudeConversationProjectSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
});
export type ClaudeConversationProject = z.infer<typeof claudeConversationProjectSchema>;

/** Una persona come la nomina una conversazione (autore, chi l'ha resa pubblica). */
export const claudeConversationPersonSchema = z.object({ id: z.uuid(), name: z.string() });

export const claudeConversationVisibilitySchema = z.enum(["private", "public"]);
export type ClaudeConversationVisibility = z.infer<typeof claudeConversationVisibilitySchema>;

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
  // ——— Fetta 5: pubbliche e continuazione (tutti additivi, con default). ———
  visibility: claudeConversationVisibilitySchema.default("private"),
  /** L'autore (D6: anche nella riga di «Public»). */
  author: claudeConversationPersonSchema.nullable().default(null),
  /** Chi guarda è l'autore: decide lui (scrivere, pubblicare, archiviare). */
  isOwner: z.boolean().default(true),
  publishedAt: z.iso.datetime().nullable().default(null),
  publishedBy: claudeConversationPersonSchema.nullable().default(null),
  /** I progetti confermati pubblicando, fra quelli che chi guarda vede. */
  publishedProjects: z.array(claudeConversationProjectSchema).default([]),
  /**
   * Per un lettore: c'è un seguito che non vede (un turno in corso, o che ha
   * toccato un progetto nuovo). Per l'autore è sempre false.
   */
  privateTail: z.boolean().default(false),
  /**
   * Per l'autore di una pubblica: i progetti NUOVI del seguito privato, da
   * riconfermare perché i lettori lo ricevano. Vuoto per chi non è l'autore.
   */
  heldProjects: z.array(claudeConversationProjectSchema).default([]),
  /** La pubblica da cui nasce (continuazione); `available: false` se è stata eliminata o non si vede più. */
  continuesFrom: z.object({ id: z.uuid(), available: z.boolean() }).nullable().default(null),
  /** Solo l'autore di una libera non archiviata. */
  canPublish: z.boolean().default(false),
  /** Chi NON è l'autore di una pubblica che vede: la continua (una conversazione nuova, sua). */
  canContinue: z.boolean().default(false),
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

/**
 * `GET /api/claude/conversations?scope=mine|public&archived=`: le proprie, o
 * (fetta 5) le pubbliche di altri, non archiviate, con `claude.public.view`.
 */
export const claudeConversationListQuerySchema = z.object({
  scope: z.enum(["mine", "public"]).default("mine"),
  archived: z.enum(["true", "false"]).default("false"),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().max(200).optional(),
});

/**
 * `POST /api/claude/conversations/:id/visibility` (fetta 5): solo l'autore.
 * Pubblicare vuole i progetti letti o toccati CONFERMATI: senza, o con un
 * elenco che non è più quello di adesso, 409 `needs_confirmation`. Con una
 * pubblica che ha un seguito privato, la stessa chiamata con i progetti nuovi
 * lo rilascia (la riconferma). `private` azzera la pubblicazione.
 */
export const setClaudeConversationVisibilitySchema = z.object({
  visibility: claudeConversationVisibilitySchema,
  confirmedProjectIds: z.array(z.uuid()).max(500).optional(),
});
export type SetClaudeConversationVisibilityInput = z.infer<typeof setClaudeConversationVisibilitySchema>;

/** Il 409 di `…/visibility`: cosa l'autore deve confermare. */
export const claudeVisibilityConfirmationSchema = z.object({
  code: z.literal("needs_confirmation"),
  message: z.string().default(""),
  /** I progetti letti o toccati (alla riconferma: solo i nuovi). */
  projects: z.array(claudeConversationProjectSchema),
  /**
   * La conversazione ha letture dei tool: chi legge vedrà anche ciò che Claude
   * ha letto per te (D1 del maintainer, 10 nov 2026). Il dialogo lo DICE.
   */
  includesToolReads: z.boolean().default(false),
  /** È la riconferma di un seguito privato, non la prima pubblicazione. */
  reconfirm: z.boolean().default(false),
});
export type ClaudeVisibilityConfirmation = z.infer<typeof claudeVisibilityConfirmationSchema>;

/**
 * `POST /api/claude/conversations/:id/continue` (fetta 5): chi non è l'autore
 * di una pubblica che vede la CONTINUA. Nasce una conversazione nuova,
 * privata, sua; il primo messaggio (facoltativo) è il suo primo turno, e
 * Claude agisce come lui.
 */
export const continueClaudeConversationSchema = z.object({
  message: z.string().trim().min(1).max(CLAUDE_CONVERSATION_MESSAGE_MAX).optional(),
});
export type ContinueClaudeConversationInput = z.input<typeof continueClaudeConversationSchema>;

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
  // Area 5, fetta 1: una pagina Docs intera (repository e slug da search_docs).
  "read_doc_page",
  "read_project_overview",
  // Area 5, fetta 3: il Drive. Il testo dei file è contenuto NON fidato.
  "search_drive",
  "read_drive_file",
  // Area 8, F1 («Spiega»): un rilascio per codice. Titolo, note e run sono contenuto NON fidato.
  "read_release",
] as const;
export type ChatReadToolName = (typeof CHAT_READ_TOOLS)[number];
/** Il solo tool che non legge: scrive una proposta, mai un'esecuzione diretta. */
export const CHAT_PROPOSE_TOOL = "propose_action" as const;
export const CHAT_TOOLS = [...CHAT_READ_TOOLS, CHAT_PROPOSE_TOOL] as const;
export type ChatToolName = (typeof CHAT_TOOLS)[number];
export const CHAT_TOOL_NAMES: readonly string[] = CHAT_TOOLS.map((tool) => `mcp__${CHAT_MCP_SERVER_NAME}__${tool}`);
/**
 * @Claude nella Chat (area 4, fetta 3): UNA domanda a scelta a chi ha chiamato.
 * Esiste SOLO nei turni di una chiamata (`chat_mention`), e non passa dal
 * server: la scrive il worker nel DB (il token del turno resta GET-only più le
 * proposte).
 */
export const CHAT_ASK_TOOL = "ask_question" as const;
export const CHAT_MENTION_TOOL_NAMES: readonly string[] = [
  ...CHAT_TOOL_NAMES,
  `mcp__${CHAT_MCP_SERVER_NAME}__${CHAT_ASK_TOOL}`,
];
