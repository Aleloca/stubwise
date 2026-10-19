import {
  backlogItemBaseSchema,
  backlogItemDetailSchema,
  backlogPageSchema,
  convertBacklogResultSchema,
  createBacklogResultSchema,
  backlogItemStatusSchema,
  backlogJobResultSchema,
  backlogRiskSchema,
  backlogUrgencySchema,
  createBacklogFromDesignSchema,
  createBacklogItemSchema,
  setContentSchema,
  startRefineSessionInputSchema,
  startRefineSessionResultSchema,
  updateBacklogItemSchema,
  type BacklogItemBase,
} from "@stubwise/shared";
import { and, asc, desc, eq, ilike, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  hasActionableSuggested,
  removeBacklogItemDesign,
  setBacklogItemDesign,
  setBacklogItemPlan,
  updateBacklogItemMetadata,
} from "@stubwise/notifications";
import { z } from "zod";
import type { Db } from "@stubwise/db";
import { backlogItems, backlogItemTickets, backlogJobs, projects, tickets } from "@stubwise/db";
import { requireAuth } from "../auth/session.js";
import { convertBacklogItem } from "../services/backlog.js";
import {
  closeRefineSession,
  closeRefineSessionForItem,
  loadRefineSessionView,
  startRefineSession,
} from "../services/backlog-refine.js";
import { enqueueBacklogIntake } from "../services/backlog-intake.js";
import { apiError } from "../errors.js";
import { buildMergeDocumentPrompt } from "./backlog-rag.js";
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

// Le forme pubbliche di una voce di backlog — lista, base, dettaglio, i loro
// pezzi e l'involucro paginato — vivono TUTTE in `@stubwise/shared`: le
// condividono server, SPA e app mobile.
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

/** Body di merge: la voce di destinazione che assorbe questa. */
const mergeBodySchema = z.object({ targetId: z.uuid() });

/** Colonne "base" della voce (esplicite: mai `embedding`). */
const baseColumns = {
  id: backlogItems.id,
  projectId: backlogItems.projectId,
  title: backlogItems.title,
  document: backlogItems.document,
  implementationPlan: backlogItems.implementationPlan,
  originContent: backlogItems.originContent,
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
): Promise<BacklogItemBase | null> {
  const [row] = await db.select(baseColumns).from(backlogItems).where(eq(backlogItems.id, id));
  if (!row) return null;
  const similarTo = await resolveSimilar(db, row.similarToId);
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    document: row.document,
    implementationPlan: row.implementationPlan,
    originContent: row.originContent,
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
        response: { 200: backlogPageSchema, 400: errorSchema, ...authErrorResponses },
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
      // Le condizioni di FILTRO, senza il cursore: vedi il gemello in
      // `routes/tickets.ts` e il docblock di `ticketPageSchema.total` — il
      // cursore è paginazione, non un filtro, e nel totale non entra.
      const filterConditions = [...conditions];

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

      // `total`: quante voci soddisfano i filtri, indipendentemente dalla
      // pagina (design §2.1). Gemello del conteggio in `routes/tickets.ts`.
      const [totalRow] = await app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(backlogItems)
        .where(filterConditions.length > 0 ? and(...filterConditions) : undefined);
      const total = totalRow?.count ?? 0;

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
        total,
      };
    },
  );

  // Stato di un job intake per il polling del server MCP: dato il jobId (Task
  // B3 lo ritorna dal POST /), restituisce status + resultItemId + error. Il
  // client MCP fa polling finché `status` è `done`, poi legge `resultItemId`
  // per scrivere il riferimento all'item creato. requireAuth basta: espone solo
  // metadati di coda, non dati sensibili. Registrata PRIMA di `/:id` per
  // fugare ogni dubbio di shadowing (in Fastify le due profondità non
  // collidono comunque: `/jobs/:jobId` è a due segmenti, `/:id` a uno).
  app.get(
    "/jobs/:jobId",
    {
      preHandler: requireAuth,
      schema: {
        params: z.object({ jobId: z.uuid() }),
        response: {
          200: backlogJobResultSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const [job] = await app.db
        .select({
          status: backlogJobs.status,
          resultItemId: backlogJobs.resultItemId,
          error: backlogJobs.error,
        })
        .from(backlogJobs)
        .where(eq(backlogJobs.id, request.params.jobId));
      if (!job) return apiError(reply, 404, "job_not_found", "Job not found");
      return { status: job.status, resultItemId: job.resultItemId, error: job.error };
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

      const [ticketRows, refineSession] = await Promise.all([
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
        loadRefineSessionView(app.db, id),
      ]);

      return { ...base, tickets: ticketRows, refineSession };
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
      preHandler: requireAuth,
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
        .select({ id: backlogItems.id })
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

      // Archiviare chiude anche la sessione di refinement della voce, nella
      // STESSA transazione (refinement §5.6): lo fa il callback del modulo, con
      // la voce già in lock.
      const res = await updateBacklogItemMetadata(
        app.db,
        id,
        { title, effort, risk, riskNote, urgency },
        {
          ...(status !== undefined ? { status } : {}),
          onArchive: async (tx) => {
            await closeRefineSessionForItem(tx, id);
          },
        },
      );
      if (res === "not_found") return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      const updated = await loadBaseItem(app.db, id);
      // La voce può sparire tra l'update e la rilettura (race con una delete).
      if (!updated) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      return updated;
    },
  );

  // --- Design collegato (document) -----------------------------------------
  //
  // PUT sostituisce il `document` con un design fornito dall'esterno (es. dalla
  // skill/MCP che collega un doc a una voce) PRESERVANDO il documento originale
  // in `originContent` — una sola volta: se un design è già attivo
  // (`originContent` non null) l'origine NON viene sovrascritta. DELETE ripristina
  // l'origine e azzera `originContent`. requireAuth (non admin): collegare un
  // design è lavoro quotidiano. Transazionale.
  app.put(
    "/:id/design",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: setContentSchema,
        response: {
          200: backlogItemBaseSchema,
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { content } = request.body;

      const res = await setBacklogItemDesign(app.db, id, content);
      if (res === "not_found") return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");

      const updated = await loadBaseItem(app.db, id);
      if (!updated) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      return updated;
    },
  );

  // Rimuove il design collegato: ripristina il `document` da `originContent` e lo
  // azzera. 404 se non c'è alcun design attivo (`originContent` null).
  app.delete(
    "/:id/design",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: {
          200: backlogItemBaseSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const found = await removeBacklogItemDesign(app.db, id);
      if (found === "not_found") {
        return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      }
      if (found === "no_design") {
        return apiError(reply, 404, "no_active_design", "No active design to remove");
      }

      const updated = await loadBaseItem(app.db, id);
      if (!updated) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      return updated;
    },
  );

  // --- Piano di implementazione --------------------------------------------
  //
  // PUT imposta `implementationPlan`, DELETE lo azzera. requireAuth (non admin).
  app.put(
    "/:id/plan",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: setContentSchema,
        response: {
          200: backlogItemBaseSchema,
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { content } = request.body;

      const res = await setBacklogItemPlan(app.db, id, content);
      if (res === "not_found") return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");

      const updated = await loadBaseItem(app.db, id);
      if (!updated) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      return updated;
    },
  );

  app.delete(
    "/:id/plan",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: {
          200: backlogItemBaseSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const res = await setBacklogItemPlan(app.db, id, null);
      if (res === "not_found") return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");

      const updated = await loadBaseItem(app.db, id);
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
          202: createBacklogResultSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, title, body } = request.body;
      const result = await enqueueBacklogIntake(app.db, { projectId, title, body });
      if (!result.ok) return apiError(reply, 404, "project_not_found", "Project not found");
      return reply.code(202).send({ queued: true, jobId: result.jobId });
    },
  );

  // Creazione da design pronto: a differenza dell'intake, crea la voce SINCRONA
  // col design come `document` verbatim (nessun agente che riassume) e accoda un
  // job `estimate` che riempie titolo affinato/stime/embedding. Insert + job
  // nella STESSA transazione per atomicità (niente voce senza il suo estimate).
  app.post(
    "/from-design",
    {
      preHandler: requireAuth,
      schema: {
        body: createBacklogFromDesignSchema,
        response: {
          201: z.object({ itemId: z.uuid(), url: z.string() }),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, title, design } = request.body;
      const [project] = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) return apiError(reply, 404, "project_not_found", "Project not found");

      const itemId = await app.db.transaction(async (tx) => {
        const [item] = await tx
          .insert(backlogItems)
          .values({ projectId, title, document: design, source: "manual" })
          .returning({ id: backlogItems.id });
        await tx
          .insert(backlogJobs)
          .values({ projectId, kind: "estimate", payload: { itemId: item!.id } });
        return item!.id;
      });

      return reply.code(201).send({ itemId, url: `${app.publicUrl}/backlog/${itemId}` });
    },
  );

  // Accetta TUTTI i metadati suggeriti: li applica ai campi reali e azzera
  // `suggested`. 409 se non c'è nulla da accettare.
  app.post(
    "/:id/suggested/accept",
    {
      preHandler: requireAuth,
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
      preHandler: requireAuth,
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


  // --- Sessione di refinement (design 2026-10-14) ---------------------------
  //
  // Chiunque possa lavorare sul backlog (requireAuth). L'avvio
  // NON fa partire niente: il turno nasce dal messaggio (relay → scheduler nel
  // worker). La chiusura è idempotente: 204 anche senza sessione o già chiusa.
  app.post(
    "/:id/refine-session",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: startRefineSessionInputSchema,
        response: {
          200: startRefineSessionResultSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const res = await startRefineSession(app.db, request.user!, request.params.id, request.body.message);
      if (res.ok) return { agentSessionId: res.agentSessionId, inputId: res.inputId };
      return res.error === "not_found"
        ? apiError(reply, 404, "backlog_item_not_found", "Backlog item not found")
        : apiError(reply, 409, "item_closed", "Backlog item is converted or archived");
    },
  );

  app.delete(
    "/:id/refine-session",
    {
      preHandler: requireAuth,
      schema: { params: idParamsSchema, response: { 204: z.null(), 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const res = await closeRefineSession(app.db, request.user!, request.params.id);
      if (!res.ok) return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
      return reply.code(204).send(null);
    },
  );


  // --- Converti in task ----------------------------------------------------
  //
  // Crea un ticket `task` col documento come corpo, priorità dall'urgenza ed
  // effort già valorizzato, riusando createTicket (numero sequenziale per-
  // progetto, row-lock su projects). NON accoda alcun aiJob: il gate di
  // automazione o il run manuale decideranno. Linka con role=converted_to e
  // porta la voce in `converted`. Tutto transazionale (createTicket apre un
  // savepoint annidato). requireAuth (non admin): promuovere un'idea a task è
  // lavoro da operator — la conversione non fa partire nulla da sola, ed è il
  // gate del piano (services/jobs.ts) a decidere se un member può eseguire.
  //
  // Il corpo vive in `services/backlog.ts` (`convertBacklogItem`), perché il
  // pulse della fase 2 converte la proposta scelta senza passare da HTTP: qui
  // resta solo l'adattatore che mappa gli errori tipizzati sugli status.
  app.post(
    "/:id/convert",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: {
          200: convertBacklogResultSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await convertBacklogItem(app.db, {
        itemId: request.params.id,
        actor: request.user!,
      });
      if (!result.ok) {
        if (result.error === "not_found") {
          return apiError(reply, 404, "backlog_item_not_found", "Backlog item not found");
        }
        if (result.error === "not_convertible") {
          return apiError(reply, 409, "not_convertible", "Backlog item cannot be converted");
        }
        return apiError(reply, 409, "already_converted", "Backlog item already converted");
      }
      return { ticketId: result.ticketId, ticketNumber: result.ticketNumber };
    },
  );

  // --- Fondi con… (merge manuale) ------------------------------------------
  //
  // Fonde QUESTA voce (assorbita) in `targetId` (destinazione): sposta i link
  // ticket (upsert per evitare conflitti PK), somma i requestCount, integra i
  // documenti via una chiamata one-shot all'LLM e archivia l'assorbita con
  // mergedIntoId. La
  // chiamata LLM è FUORI transazione (prima degli update); il resto è atomico.
  app.post(
    "/:id/merge",
    {
      preHandler: requireAuth,
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
        // Anche qui è un'archiviazione: chiude la sessione di refinement
        // dell'assorbita (la voce è in lock dall'UPDATE sopra).
        await closeRefineSessionForItem(tx, id);
      });

      const updated = await loadBaseItem(app.db, targetId);
      if (!updated) return apiError(reply, 404, "target_not_found", "Target backlog item not found");
      return updated;
    },
  );

}
