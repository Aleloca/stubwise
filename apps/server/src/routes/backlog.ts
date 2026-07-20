import {
  backlogItemSourceSchema,
  backlogItemStatusSchema,
  backlogRiskSchema,
  backlogSuggestedSchema,
  backlogUrgencySchema,
  createBacklogItemSchema,
  updateBacklogItemSchema,
  type BacklogSuggested,
} from "@stubwise/shared";
import { and, asc, desc, eq, ilike, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import {
  backlogChatMessages,
  backlogItems,
  backlogItemTickets,
  backlogJobs,
  backlogTicketRole,
  projects,
  tickets,
} from "@stubwise/db";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

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

const backlogItemDetailSchema = backlogItemBaseSchema.extend({
  tickets: z.array(linkedTicketSchema),
  messages: z.array(chatMessageSchema),
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

      const [ticketRows, messageRows] = await Promise.all([
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
          202: z.object({ queued: z.literal(true) }),
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

      await app.db
        .insert(backlogJobs)
        .values({ projectId, kind: "intake", payload: { title, body } });
      return reply.code(202).send({ queued: true });
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
}
