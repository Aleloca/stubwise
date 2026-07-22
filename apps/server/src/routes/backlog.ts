import {
  backlogCodeSessionStatusSchema,
  backlogItemSourceSchema,
  backlogItemStatusSchema,
  backlogRiskSchema,
  backlogSuggestedSchema,
  backlogUrgencySchema,
  createBacklogItemSchema,
  startCodeSessionSchema,
  updateBacklogItemSchema,
  type BacklogSuggested,
} from "@stubwise/shared";
import { and, asc, desc, eq, ilike, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { t } from "@stubwise/i18n";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import {
  backlogChatMessages,
  backlogCodeSessions,
  backlogItems,
  backlogItemTickets,
  backlogJobs,
  backlogTicketRole,
  projects,
  repositories,
  tickets,
} from "@stubwise/db";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { createTicket } from "../db/tickets.js";
import { apiError } from "../errors.js";
import { getContentLanguage } from "../settings.js";
import {
  BACKLOG_RETRIEVAL_K,
  buildBacklogSystemPrompt,
  buildMergeDocumentPrompt,
  buildRefreshDocumentPrompt,
  type OriginTicketContext,
  type PromptMessage,
} from "./backlog-rag.js";
import { streamChatResponse, TRUNCATION_MARKER } from "./docs-chat-core.js";
import { buildCitations } from "./docs-rag.js";
import { retrieveChunksForProject } from "./docs-retrieval.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";

/**
 * Route del backlog di discovery, montate sotto /api/backlog. La lettura (lista
 * + dettaglio) è aperta a ogni utente autenticato; la modifica dei metadati e
 * l'accept/dismiss dei suggerimenti AI sono riservate agli admin. La creazione
 * manuale è una richiesta come le altre (requireAuth): non crea la voce, accoda
 * lo stesso job `intake` dei ticket deviati, così dedup e RAG passano dal worker.
 *
 * Nessun N+1: la lista risolve `similarTo` con un'unica query sull'insieme dei
 * similarToId della pagina e `ticketCount` con una subquery correlata.
 */

/** Riferimento a una voce simile suggerita dal dedup (o null). */
const similarToSchema = z.object({ id: z.uuid(), title: z.string() }).nullable();

/**
 * Voce del backlog nella lista: campi leggeri per le card. Volutamente SENZA
 * `document` né `embedding` (payload pesanti inutili in lista).
 */
const backlogListItemSchema = z.object({
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
  similarTo: similarToSchema,
  ticketCount: z.number().int(),
});

const listResponseSchema = z.object({
  items: z.array(backlogListItemSchema),
  nextCursor: z.string().nullable(),
});

/**
 * Forma "base" della voce: tutti i campi confermati più `document`, `suggested`
 * e `similarTo` risolto (SENZA `embedding`). È la risposta di PATCH/accept/dismiss
 * e il nucleo del dettaglio, che vi aggiunge `tickets` e `messages`.
 */
const backlogItemBaseSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  title: z.string(),
  document: z.string(),
  status: backlogItemStatusSchema,
  effort: z.number().int().nullable(),
  risk: backlogRiskSchema.nullable(),
  riskNote: z.string().nullable(),
  urgency: backlogUrgencySchema.nullable(),
  requestCount: z.number().int(),
  source: backlogItemSourceSchema,
  suggested: backlogSuggestedSchema.nullable(),
  similarTo: similarToSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Ticket collegato a una voce (join backlog_item_tickets → tickets). */
const linkedTicketSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  role: z.enum(backlogTicketRole.enumValues),
});

/** Messaggio della chat di raffinamento (una sola conversazione per voce). */
const chatMessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(backlogChatMessages.role.enumValues),
  content: z.string(),
  citations: z.unknown().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * Sessione di analisi sul codice ATTIVA di una voce (o null). In modalità code
 * ogni messaggio della chat diventa un turno dell'agente sul repo. Espone lo
 * stretto necessario alla UI: stato, repo su cui investiga e istante d'avvio.
 */
const codeSessionSchema = z.object({
  status: backlogCodeSessionStatusSchema,
  repositoryId: z.uuid(),
  startedAt: z.iso.datetime(),
});

const backlogItemDetailSchema = backlogItemBaseSchema.extend({
  tickets: z.array(linkedTicketSchema),
  messages: z.array(chatMessageSchema),
  // True se esiste un job deep_dive queued/running per la voce (UI: "analisi in
  // corso" con polling).
  deepDivePending: z.boolean(),
  // Sessione di analisi sul codice attiva (o null): la chat è in modalità code.
  codeSession: codeSessionSchema.nullable(),
  // True se esiste un job chat_turn queued/running per la voce (UI: "sta
  // investigando nel codice…" con polling).
  pendingTurn: z.boolean(),
});

const listQuerySchema = z.object({
  projectId: z.uuid().optional(),
  status: backlogItemStatusSchema.optional(),
  urgency: backlogUrgencySchema.optional(),
  risk: backlogRiskSchema.optional(),
  q: z.string().min(1).max(300).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const idParamsSchema = z.object({ id: z.uuid() });

/** Body della chat di raffinamento: un messaggio non vuoto. */
const chatBodySchema = z.object({ message: z.string().min(1).max(8000) });

/** Body di merge: la voce di destinazione che assorbe questa. */
const mergeBodySchema = z.object({ targetId: z.uuid() });

/** Body di deep dive: il repository su cui condurre l'analisi. */
const deepDiveBodySchema = z.object({ repositoryId: z.uuid() });

/** Stati di un job del backlog considerati "in corso" (per il dedup deep dive). */
const ACTIVE_JOB_STATUSES = ["queued", "running"] as const;

/**
 * Contenuto esatto del messaggio `system` che marca l'ultimo "Aggiorna
 * documento". I refresh successivi sintetizzano solo la conversazione DOPO
 * l'ultimo marker (delta), non tutta la storia. Deve restare stabile: è
 * confrontato per uguaglianza.
 */
const DOCUMENT_UPDATED_MARKER = "Documento aggiornato.";

/** Forma difensiva dell'output JSON di "Aggiorna documento". */
const refreshOutputSchema = z.object({
  document: z.string(),
  suggested: backlogSuggestedSchema.optional(),
});

/** Colonne "base" della voce (esplicite: mai `embedding`). */
const baseColumns = {
  id: backlogItems.id,
  projectId: backlogItems.projectId,
  title: backlogItems.title,
  document: backlogItems.document,
  status: backlogItems.status,
  effort: backlogItems.effort,
  risk: backlogItems.risk,
  riskNote: backlogItems.riskNote,
  urgency: backlogItems.urgency,
  requestCount: backlogItems.requestCount,
  source: backlogItems.source,
  suggested: backlogItems.suggested,
  similarToId: backlogItems.similarToId,
  createdAt: backlogItems.createdAt,
  updatedAt: backlogItems.updatedAt,
} as const;

/** Campi della voce modificabili via update (mai `embedding`/`document` da qui). */
type ItemUpdate = Partial<
  Pick<
    typeof backlogItems.$inferInsert,
    "title" | "status" | "effort" | "risk" | "riskNote" | "urgency" | "suggested"
  >
>;

/**
 * Chiavi AZIONABILI di `suggested`: i metadati promuovibili sui campi reali.
 * `reason` è la motivazione dei suggerimenti, non un metadato: da sola non
 * tiene vivo l'oggetto (né dà nulla da accettare).
 */
const ACTIONABLE_SUGGESTED_KEYS = ["effort", "risk", "riskNote", "urgency"] as const;

/** True se `suggested` contiene almeno un metadato azionabile. */
function hasActionableSuggested(
  suggested: BacklogSuggested | null | undefined,
): suggested is BacklogSuggested {
  return suggested != null && ACTIONABLE_SUGGESTED_KEYS.some((k) => suggested[k] !== undefined);
}

/** Risolve il riferimento `similarTo` di una singola voce (una query se presente). */
async function resolveSimilar(
  db: Db,
  similarToId: string | null,
): Promise<{ id: string; title: string } | null> {
  if (!similarToId) return null;
  const [row] = await db
    .select({ id: backlogItems.id, title: backlogItems.title })
    .from(backlogItems)
    .where(eq(backlogItems.id, similarToId));
  return row ?? null;
}

/** Carica la voce nella forma base (con similarTo risolto), o null se assente. */
async function loadBaseItem(
  db: Db,
  id: string,
): Promise<z.infer<typeof backlogItemBaseSchema> | null> {
  const [row] = await db.select(baseColumns).from(backlogItems).where(eq(backlogItems.id, id));
  if (!row) return null;
  const similarTo = await resolveSimilar(db, row.similarToId);
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    document: row.document,
    status: row.status,
    effort: row.effort,
    risk: row.risk,
    riskNote: row.riskNote,
    urgency: row.urgency,
    requestCount: row.requestCount,
    source: row.source,
    suggested: row.suggested ?? null,
    similarTo,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Cursore di paginazione (identico a /api/tickets): il timestamp resta la
 * stringa testuale di Postgres (microsecondi) e viene ricastato a timestamptz
 * solo nella query.
 *
 * NB: gli helper cursor qui sotto sono una copia di quelli in tickets.ts —
 * tenere i due file in sync (l'estrazione in shared.ts è rimandata).
 */
interface Cursor {
  createdAt: string;
  id: string;
}

/** Formato testuale di `timestamptz::text` di Postgres. */
const CURSOR_TIMESTAMP_PATTERN =
  /^\d{4}-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?[+-]\d{2}(:\d{2})?$/;

/** True se i campi del timestamp stanno nei range di un istante reale. */
function isPlausibleTimestamp(match: RegExpMatchArray): boolean {
  const month = Number(match[1]);
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59
  );
}

/** Codifica il cursore opaco: base64url di `createdAt|id`. */
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url");
}

/** Decodifica e valida il cursore. Restituisce null se malformato (→ 400). */
function decodeCursor(raw: string): Cursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator === -1) return null;
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  const match = CURSOR_TIMESTAMP_PATTERN.exec(createdAt);
  if (!match || !isPlausibleTimestamp(match)) return null;
  if (!z.uuid().safeParse(id).success) return null;
  return { createdAt, id };
}

/** Ticket d'origine (role=origin) della voce, con titolo+corpo per il prompt. */
async function loadOriginTickets(db: Db, itemId: string): Promise<OriginTicketContext[]> {
  return db
    .select({ number: tickets.number, title: tickets.title, body: tickets.body })
    .from(backlogItemTickets)
    .innerJoin(tickets, eq(tickets.id, backlogItemTickets.ticketId))
    .where(and(eq(backlogItemTickets.itemId, itemId), eq(backlogItemTickets.role, "origin")))
    .orderBy(asc(tickets.number));
}

/**
 * Storico della chat di una voce, normalizzato per l'LLM. I messaggi `system`
 * (esiti deep dive, marker "documento aggiornato") sono inclusi come turni
 * `user` con prefisso `[system]`: sono contesto utile, non ruoli LLM a sé.
 * Turni consecutivi dello stesso ruolo sono FUSI (l'API dei modelli vuole ruoli
 * alternati): due `user` di fila — es. un `[system]` seguito dalla domanda —
 * diventano un solo turno.
 */
async function loadBacklogHistory(db: Db, itemId: string): Promise<PromptMessage[]> {
  const rows = await db
    .select({ role: backlogChatMessages.role, content: backlogChatMessages.content })
    .from(backlogChatMessages)
    .where(eq(backlogChatMessages.itemId, itemId))
    .orderBy(asc(backlogChatMessages.createdAt), asc(backlogChatMessages.id));

  const mapped: PromptMessage[] = rows.map((r) =>
    r.role === "assistant"
      ? { role: "assistant", content: r.content }
      : r.role === "system"
        ? { role: "user", content: `[system] ${r.content}` }
        : { role: "user", content: r.content },
  );

  // Fonde i turni consecutivi con lo stesso ruolo (ruoli alternati richiesti).
  const merged: PromptMessage[] = [];
  for (const m of mapped) {
    const last = merged.at(-1);
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}

/**
 * Parsa l'output JSON di "Aggiorna documento" in modo DIFENSIVO: tollera
 * eventuali fence Markdown (```json … ```), estrae il primo oggetto `{…}` e lo
 * valida contro {@link refreshOutputSchema}. Restituisce null se non parsabile
 * o non conforme (la route mappa null → 502 e NON salva nulla).
 */
function parseRefreshOutput(raw: string): z.infer<typeof refreshOutputSchema> | null {
  let text = raw.trim();
  // Rimuove un eventuale blocco di codice ```json … ``` o ``` … ```.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Preambolo E/O postambolo attorno all'oggetto (anche quando il testo
    // INIZIA con `{` ma prosegue oltre): ritenta sempre isolando la fetta tra
    // la prima `{` e l'ultima `}`.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const result = refreshOutputSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * True se esiste un job `deep_dive` queued/running per la voce. Il legame è nel
 * `payload` jsonb (`payload->>'itemId'`): la coda non ha una colonna itemId (il
 * payload varia per kind), quindi si interroga il campo con l'operatore `->>`.
 */
async function hasPendingDeepDive(db: Db, itemId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: backlogJobs.id })
    .from(backlogJobs)
    .where(
      and(
        eq(backlogJobs.kind, "deep_dive"),
        inArray(backlogJobs.status, [...ACTIVE_JOB_STATUSES]),
        sql`${backlogJobs.payload} ->> 'itemId' = ${itemId}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * True se esiste un job `chat_turn` queued/running per la voce. Come
 * {@link hasPendingDeepDive}, il legame è in `payload->>'itemId'`: la coda non
 * ha una colonna itemId (il payload varia per kind).
 */
async function hasPendingChatTurn(db: Db, itemId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: backlogJobs.id })
    .from(backlogJobs)
    .where(
      and(
        eq(backlogJobs.kind, "chat_turn"),
        inArray(backlogJobs.status, [...ACTIVE_JOB_STATUSES]),
        sql`${backlogJobs.payload} ->> 'itemId' = ${itemId}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Sessione di analisi sul codice ATTIVA della voce (o null). */
async function loadActiveCodeSession(
  db: Db,
  itemId: string,
): Promise<z.infer<typeof codeSessionSchema> | null> {
  const [row] = await db
    .select({
      status: backlogCodeSessions.status,
      repositoryId: backlogCodeSessions.repositoryId,
      startedAt: backlogCodeSessions.startedAt,
    })
    .from(backlogCodeSessions)
    .where(and(eq(backlogCodeSessions.itemId, itemId), eq(backlogCodeSessions.status, "active")))
    .limit(1);
  if (!row) return null;
  return { status: row.status, repositoryId: row.repositoryId, startedAt: row.startedAt.toISOString() };
}

/** Accumula lo stream one-shot dell'LLM in una stringa (nessun SSE). */
async function collectStream(
  chatLlm: FastifyInstance["chatLlm"],
  system: string,
  message: string,
): Promise<string> {
  let text = "";
  for await (const delta of chatLlm.stream({
    system,
    messages: [{ role: "user", content: message }],
  })) {
    text += delta;
  }
  return text;
}

export async function backlogRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        querystring: listQuerySchema,
        response: { 200: listResponseSchema, 400: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { projectId, status, urgency, risk, q, cursor, limit } = request.query;

      const conditions: SQL[] = [];
      if (projectId) conditions.push(eq(backlogItems.projectId, projectId));
      // Senza `status` esplicito la lista nasconde gli stati "chiusi"
      // (converted/archived); con `status` mostra solo quello.
      if (status) conditions.push(eq(backlogItems.status, status));
      else conditions.push(notInArray(backlogItems.status, ["converted", "archived"]));
      if (urgency) conditions.push(eq(backlogItems.urgency, urgency));
      if (risk) conditions.push(eq(backlogItems.risk, risk));
      if (q) {
        // ILIKE sul titolo; i metacaratteri LIKE dell'utente sono escapati.
        const likePattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        conditions.push(ilike(backlogItems.title, likePattern));
      }
      if (cursor !== undefined) {
        const decoded = decodeCursor(cursor);
        if (!decoded) {
          return apiError(reply, 400, "invalid_cursor", "Invalid pagination cursor");
        }
        // Tutto ciò che viene strettamente "dopo" il cursore (createdAt DESC, id DESC).
        conditions.push(
          sql`(${backlogItems.createdAt}, ${backlogItems.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)`,
        );
      }

      // `ticketCount` = ticket con role=origin (subquery correlata, no N+1).
      // `createdAt::text` preserva i microsecondi per il cursore.
      const rows = await app.db
        .select({
          id: backlogItems.id,
          projectId: backlogItems.projectId,
          title: backlogItems.title,
          status: backlogItems.status,
          effort: backlogItems.effort,
          risk: backlogItems.risk,
          riskNote: backlogItems.riskNote,
          urgency: backlogItems.urgency,
          requestCount: backlogItems.requestCount,
          source: backlogItems.source,
          similarToId: backlogItems.similarToId,
          createdAt: backlogItems.createdAt,
          updatedAt: backlogItems.updatedAt,
          ticketCount: sql<number>`(
            select count(*)::int from ${backlogItemTickets}
            where ${backlogItemTickets.itemId} = ${backlogItems.id}
              and ${backlogItemTickets.role} = 'origin'
          )`,
          cursorTimestamp: sql<string>`${backlogItems.createdAt}::text`,
        })
        .from(backlogItems)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(backlogItems.createdAt), desc(backlogItems.id))
        // Una riga in più del limite: se arriva, esiste una pagina successiva.
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.cursorTimestamp, id: last.id })
          : null;

      // Titoli delle voci "simili" della pagina in un'unica query (no N+1).
      const similarIds = [
        ...new Set(
          page.map((r) => r.similarToId).filter((x): x is string => x !== null),
        ),
      ];
      const similarById = new Map<string, { id: string; title: string }>();
      if (similarIds.length > 0) {
        const sims = await app.db
          .select({ id: backlogItems.id, title: backlogItems.title })
          .from(backlogItems)
          .where(inArray(backlogItems.id, similarIds));
        for (const s of sims) similarById.set(s.id, s);
      }

      return {
        items: page.map((r) => ({
          id: r.id,
          projectId: r.projectId,
          title: r.title,
          status: r.status,
          effort: r.effort,
          risk: r.risk,
          riskNote: r.riskNote,
          urgency: r.urgency,
          requestCount: r.requestCount,
          source: r.source,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          similarTo: r.similarToId ? (similarById.get(r.similarToId) ?? null) : null,
          ticketCount: r.ticketCount,
        })),
        nextCursor,
      };
    },
  );

  app.get(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 200: backlogItemDetailSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const base = await loadBaseItem(app.db, id);
      if (!base) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");

      const [ticketRows, messageRows, deepDivePending, codeSession, pendingTurn] = await Promise.all([
        app.db
          .select({
            id: tickets.id,
            number: tickets.number,
            title: tickets.title,
            role: backlogItemTickets.role,
          })
          .from(backlogItemTickets)
          .innerJoin(tickets, eq(tickets.id, backlogItemTickets.ticketId))
          .where(eq(backlogItemTickets.itemId, id))
          .orderBy(asc(backlogItemTickets.createdAt)),
        app.db
          .select()
          .from(backlogChatMessages)
          .where(eq(backlogChatMessages.itemId, id))
          .orderBy(asc(backlogChatMessages.createdAt), asc(backlogChatMessages.id)),
        hasPendingDeepDive(app.db, id),
        loadActiveCodeSession(app.db, id),
        hasPendingChatTurn(app.db, id),
      ]);

      return {
        ...base,
        tickets: ticketRows,
        messages: messageRows.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          citations: m.citations ?? null,
          createdAt: m.createdAt.toISOString(),
        })),
        deepDivePending,
        codeSession,
        pendingTurn,
      };
    },
  );

  // Modifica manuale dei metadati (solo admin). Per ogni metadato impostato a
  // mano si azzera il campo corrispondente in `suggested` (il valore proposto
  // non ha più senso una volta deciso dall'umano); se `suggested` resta vuoto
  // diventa null. La transizione verso `converted` è vietata: solo l'endpoint di
  // conversione (Task 11) può portare una voce in quello stato. `updatedAt` si
  // aggiorna da solo ($onUpdate).
  app.patch(
    "/:id",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: updateBacklogItemSchema,
        response: {
          200: backlogItemBaseSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { title, status, effort, risk, riskNote, urgency } = request.body;

      const [current] = await app.db
        .select({ suggested: backlogItems.suggested })
        .from(backlogItems)
        .where(eq(backlogItems.id, id));
      if (!current) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");

      // Dopo il 404: un id inesistente resta 404 anche con status=converted.
      if (status === "converted") {
        return apiError(
          reply,
          409,
          "convert_not_allowed",
          "A backlog item can only reach 'converted' via the convert endpoint",
        );
      }

      const updates: ItemUpdate = {};
      if (title !== undefined) updates.title = title;
      if (status !== undefined) updates.status = status;
      if (effort !== undefined) updates.effort = effort;
      if (risk !== undefined) updates.risk = risk;
      if (riskNote !== undefined) updates.riskNote = riskNote;
      if (urgency !== undefined) updates.urgency = urgency;

      // Azzera in `suggested` i metadati appena decisi a mano (mappa 1:1).
      // Senza più metadati azionabili l'oggetto diventa null: un `reason`
      // orfano (motivazione senza suggerimenti) non lo tiene vivo.
      if (
        current.suggested &&
        (effort !== undefined ||
          risk !== undefined ||
          riskNote !== undefined ||
          urgency !== undefined)
      ) {
        const next: BacklogSuggested = { ...current.suggested };
        if (effort !== undefined) delete next.effort;
        if (risk !== undefined) delete next.risk;
        if (riskNote !== undefined) delete next.riskNote;
        if (urgency !== undefined) delete next.urgency;
        updates.suggested = hasActionableSuggested(next) ? next : null;
      }

      if (Object.keys(updates).length > 0) {
        await app.db.update(backlogItems).set(updates).where(eq(backlogItems.id, id));
      }
      const updated = await loadBaseItem(app.db, id);
      // La voce può sparire tra l'update e la rilettura (race con una delete).
      if (!updated) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      return updated;
    },
  );

  // Creazione manuale: NON crea la voce, accoda lo stesso job `intake` dei
  // ticket deviati (dedup + RAG li fa il worker). Aperta a ogni utente
  // autenticato: proporre un'idea è lavoro quotidiano.
  app.post(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        body: createBacklogItemSchema,
        response: {
          202: z.object({ queued: z.literal(true), jobId: z.uuid() }),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, title, body } = request.body;
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      const [job] = await app.db
        .insert(backlogJobs)
        .values({ projectId, kind: "intake", payload: { title, body } })
        .returning({ id: backlogJobs.id });
      return reply.code(202).send({ queued: true, jobId: job!.id });
    },
  );

  // Accetta TUTTI i metadati suggeriti: li applica ai campi reali e azzera
  // `suggested`. 409 se non c'è nulla da accettare.
  app.post(
    "/:id/suggested/accept",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: {
          200: backlogItemBaseSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const [current] = await app.db
        .select({ suggested: backlogItems.suggested })
        .from(backlogItems)
        .where(eq(backlogItems.id, id));
      if (!current) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      // Simmetrico al PATCH: senza metadati azionabili (un `reason` orfano non
      // conta) non c'è nulla da accettare.
      if (!hasActionableSuggested(current.suggested)) {
        return apiError(reply, 409, "no_suggested", "No suggested metadata to accept");
      }

      const s = current.suggested;
      const updates: ItemUpdate = { suggested: null };
      if (s.effort !== undefined) updates.effort = s.effort;
      if (s.risk !== undefined) updates.risk = s.risk;
      if (s.riskNote !== undefined) updates.riskNote = s.riskNote;
      if (s.urgency !== undefined) updates.urgency = s.urgency;

      await app.db.update(backlogItems).set(updates).where(eq(backlogItems.id, id));
      const updated = await loadBaseItem(app.db, id);
      // La voce può sparire tra l'update e la rilettura (race con una delete).
      if (!updated) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      return updated;
    },
  );

  // Scarta i metadati suggeriti: azzera `suggested` senza applicarli. 409 se non
  // c'è nulla da scartare.
  app.post(
    "/:id/suggested/dismiss",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: {
          200: backlogItemBaseSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const [current] = await app.db
        .select({ suggested: backlogItems.suggested })
        .from(backlogItems)
        .where(eq(backlogItems.id, id));
      if (!current) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      if (!current.suggested) {
        return apiError(reply, 409, "no_suggested", "No suggested metadata to dismiss");
      }

      await app.db.update(backlogItems).set({ suggested: null }).where(eq(backlogItems.id, id));
      const updated = await loadBaseItem(app.db, id);
      // La voce può sparire tra l'update e la rilettura (race con una delete).
      if (!updated) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      return updated;
    },
  );

  // --- Chat RAG di raffinamento (SSE) --------------------------------------
  //
  // UNA conversazione per voce (backlog_chat_messages). Stesso trasporto della
  // chat Docs (streamChatResponse): pre-flight isAvailable → 503 PRIMA
  // dell'hijack, poi stream SSE grezzo su reply.raw. Non c'è una tabella di
  // sessioni: la voce È la sessione, quindi `sessionId` passato a
  // streamChatResponse (per l'evento `done`) è l'id della voce stessa.
  app.post(
    "/:id/chat",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: chatBodySchema,
        // In modalità CODE la risposta è un 202 JSON (`{mode:"code",
        // userMessageId}` — l'id serve alla UI per dedupare il messaggio
        // ottimistico); in modalità DOCS (default) è uno stream SSE grezzo
        // (reply.hijack), quindi niente schema 200. Restano gli errori PRIMA
        // dello stream (404/503/auth).
        response: {
          202: z.object({ mode: z.literal("code"), userMessageId: z.uuid() }),
          404: errorSchema,
          503: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { message } = request.body;

      const item = await loadBaseItem(app.db, id);
      if (!item) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");

      // MODALITÀ CODE: se c'è una sessione di analisi attiva, il messaggio non
      // va all'LLM RAG ma diventa un turno dell'agente sul repo (worker). Tutto
      // in UNA transazione, col TOUCH di last_activity_at come PRIMA operazione
      // e GUARDIA anti-corsa: l'UPDATE condizionato su status='active' prende il
      // row-lock della sessione, quindi un DELETE concorrente si serializza (o
      // la chiude prima → 0 righe qui, o attende il commit del turno). 0 righe
      // toccate = nessuna sessione attiva → fall-through al percorso SSE docs
      // (come se la sessione non ci fosse mai stata: niente turno orfano).
      // NIENTE pre-flight chatLlm: il turno gira su claude CLI, non sul provider RAG.
      const codeTurn = await app.db.transaction(async (tx) => {
        const [session] = await tx
          .update(backlogCodeSessions)
          .set({ lastActivityAt: new Date() })
          .where(and(eq(backlogCodeSessions.itemId, id), eq(backlogCodeSessions.status, "active")))
          .returning({ id: backlogCodeSessions.id });
        if (!session) return null;

        if (item.status === "new") {
          await tx.update(backlogItems).set({ status: "refining" }).where(eq(backlogItems.id, id));
        }
        const [userMessage] = await tx
          .insert(backlogChatMessages)
          .values({ itemId: id, role: "user", content: message })
          .returning({ id: backlogChatMessages.id });
        // `sessionId` nel payload: il worker risponde NELLA sessione in cui è
        // stata posta la domanda, non in quella attiva al dequeue.
        await tx.insert(backlogJobs).values({
          projectId: item.projectId,
          kind: "chat_turn",
          payload: { itemId: id, userMessageId: userMessage!.id, sessionId: session.id },
        });
        return { userMessageId: userMessage!.id };
      });
      if (codeTurn) {
        return reply.code(202).send({ mode: "code" as const, userMessageId: codeTurn.userMessageId });
      }

      // PRE-FLIGHT disponibilità chat, PRIMA dell'hijack: 503 JSON pulito se
      // nessun provider api_key (vedi docs-chat.ts). Il fallback mid-stream resta.
      if (app.chatLlm.isAvailable) {
        const availability = await app.chatLlm.isAvailable();
        if (!availability.available) {
          return apiError(reply, 503, "chat_unavailable", "Backlog chat requires an API-key AI provider");
        }
      }

      // Persiste il messaggio utente PRIMA del retrieval/streaming: lo storico
      // passato all'LLM include così la domanda corrente in coda.
      await app.db.insert(backlogChatMessages).values({ itemId: id, role: "user", content: message });

      // Primo messaggio in chat su una voce `new` → la porta in `refining`.
      if (item.status === "new") {
        await app.db.update(backlogItems).set({ status: "refining" }).where(eq(backlogItems.id, id));
      }

      // Retrieval sulla documentazione del PROGETTO (cross-repo), stesso motore
      // condiviso della chat Docs. Se l'embedding è down → fallback full-text.
      const chunks = await retrieveChunksForProject(
        app.db,
        app.embeddingClient,
        item.projectId,
        message,
        { k: BACKLOG_RETRIEVAL_K, logger: request.log },
      );
      const citations = buildCitations(chunks);
      const originTickets = await loadOriginTickets(app.db, id);
      const system = buildBacklogSystemPrompt(item, originTickets, chunks);
      const history = await loadBacklogHistory(app.db, id);

      // Streaming SSE + persistenza dell'assistant su backlog_chat_messages.
      // Semantica di troncamento coerente col default della chat Docs: parziale
      // salvato con TRUNCATION_MARKER e SENZA citazioni (non "giustificate").
      await streamChatResponse({
        db: app.db,
        chatLlm: app.chatLlm,
        request,
        reply,
        // La voce È la sessione: nessuna tabella sessioni, l'id voce identifica
        // la conversazione nell'evento `done`.
        sessionId: id,
        system,
        history,
        citations,
        logContext: { backlogItemId: id },
        persistAssistantMessage: async ({ content, citations: cites, truncated }) => {
          await app.db.insert(backlogChatMessages).values({
            itemId: id,
            role: "assistant",
            content: truncated ? content + TRUNCATION_MARKER : content,
            citations: truncated ? null : cites,
          });
        },
      });
    },
  );

  // --- Sessione di analisi sul codice --------------------------------------
  //
  // Apre/chiude la modalità CODE della chat. Aperta a ogni utente autenticato
  // (coerente con la chat, che è per i membri). L'avvio NON fa lavoro worker: il
  // worktree si apre pigramente al primo turno (POST /:id/chat in modalità code).
  app.post(
    "/:id/code-session",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: startCodeSessionSchema,
        response: {
          201: codeSessionSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { repositoryId } = request.body;

      const [item] = await app.db
        .select({ projectId: backlogItems.projectId, status: backlogItems.status })
        .from(backlogItems)
        .where(eq(backlogItems.id, id));
      if (!item) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");

      // Una voce chiusa (convertita o archiviata) non si analizza più.
      if (item.status === "converted" || item.status === "archived") {
        return apiError(reply, 409, "item_closed", "Backlog item is converted or archived");
      }

      // Il repo deve esistere ed appartenere al progetto della voce.
      const [repo] = await app.db
        .select({ projectId: repositories.projectId, name: repositories.name })
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!repo || repo.projectId !== item.projectId) {
        return apiError(reply, 400, "repository_not_in_project", "Repository does not belong to the item's project");
      }

      // Al più una sessione attiva per voce (allineato all'indice unico parziale).
      if (await loadActiveCodeSession(app.db, id)) {
        return apiError(reply, 409, "code_session_active", "A code analysis session is already active");
      }

      const lang = await getContentLanguage(app.db);
      let created: { status: "active" | "closed"; repositoryId: string; startedAt: Date };
      try {
        created = await app.db.transaction(async (tx) => {
          // L'insert è la guardia anti-corsa: due avvii concorrenti si
          // serializzano sull'indice unico parziale (il secondo → 23505,
          // mappato a 409 nel catch). Il pre-check sopra resta per il
          // fast-path del 409 pulito.
          const [row] = await tx
            .insert(backlogCodeSessions)
            .values({ itemId: id, repositoryId, status: "active" })
            .returning({
              status: backlogCodeSessions.status,
              repositoryId: backlogCodeSessions.repositoryId,
              startedAt: backlogCodeSessions.startedAt,
            });
          await tx.insert(backlogChatMessages).values({
            itemId: id,
            role: "system",
            content: t(lang, "backlog.codeSessionStarted", { repo: repo.name }),
          });
          return row!;
        });
      } catch (error) {
        // Race di doppio start sfuggita al pre-check: l'indice unico parziale
        // respinge il secondo insert → 409 come il pre-check, non 500.
        if (isUniqueViolation(error)) {
          return apiError(reply, 409, "code_session_active", "A code analysis session is already active");
        }
        throw error;
      }

      return reply
        .code(201)
        .send({ ...created, startedAt: created.startedAt.toISOString() });
    },
  );

  // Chiude la sessione di analisi attiva della voce: → `closed` + `closed_at` +
  // messaggio system. 404 se non c'è alcuna sessione attiva.
  app.delete(
    "/:id/code-session",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: {
          200: z.object({ closed: z.literal(true) }),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const lang = await getContentLanguage(app.db);
      const closed = await app.db.transaction(async (tx) => {
        const done = await tx
          .update(backlogCodeSessions)
          .set({ status: "closed", closedAt: new Date() })
          .where(and(eq(backlogCodeSessions.itemId, id), eq(backlogCodeSessions.status, "active")))
          .returning({ id: backlogCodeSessions.id });
        if (done.length === 0) return false;
        await tx.insert(backlogChatMessages).values({
          itemId: id,
          role: "system",
          content: t(lang, "backlog.codeSessionClosed"),
        });
        return true;
      });

      if (!closed) {
        return apiError(reply, 404, "code_session_not_found", "No active code analysis session");
      }
      return reply.code(200).send({ closed: true });
    },
  );

  // --- Aggiorna documento (one-shot) ---------------------------------------
  //
  // Sintetizza la conversazione DALL'ULTIMO aggiornamento nel documento. Marca
  // il punto con un messaggio `system` ("Documento aggiornato."), così i refresh
  // successivi vedono solo il delta. 409 se non c'è nulla di nuovo da sintetizzare.
  // Chiamata one-shot: accumula lo stream, parsa JSON difensivamente (parse KO
  // → 502, niente salvataggio), aggiorna document + suggested (i nuovi
  // SOSTITUISCONO i vecchi). 503 se la chat non è servibile.
  app.post(
    "/:id/refresh-document",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: {
          200: backlogItemBaseSchema,
          404: errorSchema,
          409: errorSchema,
          502: errorSchema,
          503: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const item = await loadBaseItem(app.db, id);
      if (!item) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");

      if (app.chatLlm.isAvailable) {
        const availability = await app.chatLlm.isAvailable();
        if (!availability.available) {
          return apiError(reply, 503, "chat_unavailable", "Backlog chat requires an API-key AI provider");
        }
      }

      // Delta = messaggi dopo l'ULTIMO marker "Documento aggiornato."; se non
      // c'è mai stato un aggiornamento, tutta la storia. I `system` non-marker
      // (esiti deep dive) restano nel delta come contesto.
      const messages = await app.db
        .select({
          role: backlogChatMessages.role,
          content: backlogChatMessages.content,
        })
        .from(backlogChatMessages)
        .where(eq(backlogChatMessages.itemId, id))
        .orderBy(asc(backlogChatMessages.createdAt), asc(backlogChatMessages.id));

      let lastMarker = -1;
      messages.forEach((m, i) => {
        if (m.role === "system" && m.content === DOCUMENT_UPDATED_MARKER) lastMarker = i;
      });
      const deltaRows = messages.slice(lastMarker + 1);
      if (deltaRows.length === 0) {
        return apiError(reply, 409, "no_new_messages", "No new messages since the last document update");
      }

      const delta: PromptMessage[] = deltaRows.map((m) =>
        m.role === "assistant"
          ? { role: "assistant", content: m.content }
          : m.role === "system"
            ? { role: "user", content: `[system] ${m.content}` }
            : { role: "user", content: m.content },
      );

      const system = buildRefreshDocumentPrompt(item, delta);
      const raw = await collectStream(app.chatLlm, system, "Aggiorna il documento e restituisci il JSON richiesto.");
      const parsed = parseRefreshOutput(raw);
      if (!parsed) {
        return apiError(reply, 502, "refresh_parse_failed", "The AI response could not be parsed");
      }

      // suggested: se proposto, SOSTITUISCE il precedente (null se non azionabile);
      // se assente dal JSON, resta invariato.
      const updates: { document: string; suggested?: BacklogSuggested | null } = {
        document: parsed.document,
      };
      if (parsed.suggested !== undefined) {
        updates.suggested = hasActionableSuggested(parsed.suggested) ? parsed.suggested : null;
      }

      await app.db.transaction(async (tx) => {
        await tx.update(backlogItems).set(updates).where(eq(backlogItems.id, id));
        await tx
          .insert(backlogChatMessages)
          .values({ itemId: id, role: "system", content: DOCUMENT_UPDATED_MARKER });
      });

      const updated = await loadBaseItem(app.db, id);
      if (!updated) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      return updated;
    },
  );

  // --- Converti in task ----------------------------------------------------
  //
  // Crea un ticket `task` col documento come corpo, priorità dall'urgenza ed
  // effort già valorizzato, riusando createTicket (numero sequenziale per-
  // progetto, row-lock su projects). NON accoda alcun aiJob: il gate di
  // automazione o il run manuale decideranno. Linka con role=converted_to e
  // porta la voce in `converted`. Tutto transazionale (createTicket apre un
  // savepoint annidato).
  app.post(
    "/:id/convert",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: {
          200: z.object({ ticketId: z.uuid(), ticketNumber: z.number().int() }),
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const [item] = await app.db
        .select({
          projectId: backlogItems.projectId,
          title: backlogItems.title,
          document: backlogItems.document,
          status: backlogItems.status,
          effort: backlogItems.effort,
          urgency: backlogItems.urgency,
        })
        .from(backlogItems)
        .where(eq(backlogItems.id, id));
      if (!item) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      if (item.status === "converted") {
        return apiError(reply, 409, "already_converted", "Backlog item already converted");
      }

      const result = await app.db.transaction(async (tx) => {
        // CLAIM anti-TOCTOU come PRIMA operazione: UPDATE condizionato allo
        // stato. Due convert concorrenti si serializzano sul row-lock della
        // voce: il secondo trova 0 righe (status già converted) ed esce SENZA
        // aver creato nulla (→ 409). Il pre-check sopra resta solo per il
        // fast-path senza transazione.
        const claimed = await tx
          .update(backlogItems)
          .set({ status: "converted" })
          .where(and(eq(backlogItems.id, id), sql`${backlogItems.status} <> 'converted'`))
          .returning({ id: backlogItems.id });
        if (claimed.length === 0) return null;

        const ticket = await createTicket(tx, {
          projectId: item.projectId,
          title: item.title,
          body: item.document,
          type: "task",
          priority: item.urgency ?? "medium",
          source: "manual",
        });
        // createTicket non copre l'effort: lo propaghiamo dalla voce (già stimato).
        if (item.effort !== null) {
          await tx.update(tickets).set({ effort: item.effort }).where(eq(tickets.id, ticket.id));
        }
        await tx
          .insert(backlogItemTickets)
          .values({ itemId: id, ticketId: ticket.id, role: "converted_to" });
        // Una conversione CHIUDE l'eventuale sessione di analisi sul codice
        // active: la voce è ormai un ticket, non ha più senso investigarla in
        // chat. Il worker (sweep/turno) rimuoverà il worktree in-memoria alla
        // prossima riconciliazione; un chat_turn in volo trova la sessione closed
        // → no-op morbido. Status-guarded: nessuna sessione active → 0 righe.
        const [closedSession] = await tx
          .update(backlogCodeSessions)
          .set({ status: "closed", closedAt: new Date() })
          .where(and(eq(backlogCodeSessions.itemId, id), eq(backlogCodeSessions.status, "active")))
          .returning({ id: backlogCodeSessions.id });
        if (closedSession) {
          const lang = await getContentLanguage(tx);
          await tx.insert(backlogChatMessages).values({
            itemId: id,
            role: "system",
            content: t(lang, "backlog.codeSessionClosed"),
          });
        }
        return { ticketId: ticket.id, ticketNumber: ticket.number };
      });

      if (!result) {
        return apiError(reply, 409, "already_converted", "Backlog item already converted");
      }
      return result;
    },
  );

  // --- Fondi con… (merge manuale) ------------------------------------------
  //
  // Fonde QUESTA voce (assorbita) in `targetId` (destinazione): sposta i link
  // ticket (upsert per evitare conflitti PK), somma i requestCount, integra i
  // documenti via una chiamata one-shot all'LLM, lascia un messaggio system
  // "ponte" su entrambe le chat e archivia l'assorbita con mergedIntoId. La
  // chiamata LLM è FUORI transazione (prima degli update); il resto è atomico.
  app.post(
    "/:id/merge",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: mergeBodySchema,
        response: {
          200: backlogItemBaseSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          503: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { targetId } = request.body;

      if (id === targetId) {
        return apiError(reply, 400, "merge_self", "Cannot merge an item into itself");
      }

      const absorbed = await loadBaseItem(app.db, id);
      if (!absorbed) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      const target = await loadBaseItem(app.db, targetId);
      if (!target) return apiError(reply, 404, "target_not_found", "Target backlog item not found");

      if (absorbed.projectId !== target.projectId) {
        return apiError(reply, 400, "cross_project_merge", "Items must be in the same project");
      }
      if (target.status === "archived" || target.status === "converted") {
        return apiError(reply, 409, "target_not_mergeable", "Target item is archived or converted");
      }

      if (app.chatLlm.isAvailable) {
        const availability = await app.chatLlm.isAvailable();
        if (!availability.available) {
          return apiError(reply, 503, "chat_unavailable", "Backlog chat requires an API-key AI provider");
        }
      }

      // Integrazione dei due documenti (markdown puro, non JSON): FUORI transazione.
      const mergedDocument = await collectStream(
        app.chatLlm,
        buildMergeDocumentPrompt(target, absorbed),
        "Fondi i due documenti e restituisci il Markdown del documento risultante.",
      );

      await app.db.transaction(async (tx) => {
        // Sposta i link ticket dall'assorbita al target: upsert (onConflictDoNothing
        // sulla PK composta) per non violare il vincolo se un ticket è già linkato
        // a entrambe; role invariato. Poi elimina i link dell'assorbita.
        const links = await tx
          .select({ ticketId: backlogItemTickets.ticketId, role: backlogItemTickets.role })
          .from(backlogItemTickets)
          .where(eq(backlogItemTickets.itemId, id));
        if (links.length > 0) {
          await tx
            .insert(backlogItemTickets)
            .values(links.map((l) => ({ itemId: targetId, ticketId: l.ticketId, role: l.role })))
            .onConflictDoNothing({
              target: [backlogItemTickets.itemId, backlogItemTickets.ticketId],
            });
          await tx.delete(backlogItemTickets).where(eq(backlogItemTickets.itemId, id));
        }

        // requestCount del target += quello dell'assorbita, letto con una
        // SUBQUERY dentro la transazione (non il valore pre-LLM: la chiamata
        // AI è lunga e un intake concorrente può averlo incrementato nel
        // frattempo); documento fuso.
        await tx
          .update(backlogItems)
          .set({
            requestCount: sql`${backlogItems.requestCount} + (select bi.request_count from backlog_items bi where bi.id = ${id})`,
            document: mergedDocument,
          })
          .where(eq(backlogItems.id, targetId));

        // Assorbita → archived, con puntatore al superstite.
        await tx
          .update(backlogItems)
          .set({ status: "archived", mergedIntoId: targetId })
          .where(eq(backlogItems.id, id));

        // Messaggi "ponte" sulle due chat.
        await tx.insert(backlogChatMessages).values([
          { itemId: targetId, role: "system", content: `Assorbito item "${absorbed.title}".` },
          { itemId: id, role: "system", content: `Fuso in "${target.title}".` },
        ]);
      });

      const updated = await loadBaseItem(app.db, targetId);
      if (!updated) return apiError(reply, 404, "target_not_found", "Target backlog item not found");
      return updated;
    },
  );

  // --- Analisi approfondita (deep dive) ------------------------------------
  //
  // Accoda un job `deep_dive` sul repository scelto (deve appartenere al
  // progetto della voce). 409 se ce n'è già uno queued/running per la voce
  // (dedup su payload->>'itemId'). Non attende: 202.
  app.post(
    "/:id/deep-dive",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: deepDiveBodySchema,
        response: {
          202: z.object({ queued: z.literal(true) }),
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { repositoryId } = request.body;

      const [item] = await app.db
        .select({ projectId: backlogItems.projectId })
        .from(backlogItems)
        .where(eq(backlogItems.id, id));
      if (!item) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");

      // Il repo deve esistere ed appartenere al progetto della voce.
      const [repo] = await app.db
        .select({ projectId: repositories.projectId })
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!repo || repo.projectId !== item.projectId) {
        return apiError(reply, 400, "repository_not_in_project", "Repository does not belong to the item's project");
      }

      if (await hasPendingDeepDive(app.db, id)) {
        return apiError(reply, 409, "deep_dive_pending", "A deep dive is already queued or running");
      }

      await app.db.insert(backlogJobs).values({
        projectId: item.projectId,
        kind: "deep_dive",
        payload: { itemId: id, repositoryId },
      });
      return reply.code(202).send({ queued: true });
    },
  );
}
