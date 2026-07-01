import {
  docGenerationStatusSchema,
  docGenerationTriggerSchema,
  docJobStatusSchema,
  docPageKindSchema,
} from "@stubwise/shared";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import {
  aiProviders,
  docGenerationJobs,
  docGenerations,
  docPages,
  repositories,
} from "@stubwise/db";
import type { Db } from "@stubwise/db";
import { apiError } from "../errors.js";
import { aiProviderKindSchema } from "./ai-providers.js";
import { retrieveChunks } from "./docs-retrieval.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";

const repositoryIdParamsSchema = z.object({ repositoryId: z.uuid() });
const slugParamsSchema = z.object({ repositoryId: z.uuid(), slug: z.string().min(1) });
const manualIdParamsSchema = z.object({ repositoryId: z.uuid(), id: z.uuid() });

/** Job di generazione restituito dalle route di trigger/stato. */
const jobSchema = z.object({
  id: z.uuid(),
  status: docJobStatusSchema,
  trigger: docGenerationTriggerSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

type DocGenerationJobRow = typeof docGenerationJobs.$inferSelect;

function toJob(row: DocGenerationJobRow): z.infer<typeof jobSchema> {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Provider bloccato esposto dallo stato: l'identità minima per mostrarlo in UI.
 * `kind` riusa l'enum dei provider (account|api_key). null = nessun pin (o il
 * provider è stato eliminato nel frattempo).
 */
const pinnedProviderSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  kind: aiProviderKindSchema,
});

/** Generazione corrente (puntata da projects.currentDocGenerationId). */
const generationSchema = z.object({
  id: z.uuid(),
  status: docGenerationStatusSchema,
  commitSha: z.string().nullable(),
  model: z.string().nullable(),
  cost: z.string().nullable(),
  stats: z.unknown().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});

type DocGenerationRow = typeof docGenerations.$inferSelect;

function toGeneration(row: DocGenerationRow): z.infer<typeof generationSchema> {
  return {
    id: row.id,
    status: row.status,
    commitSha: row.commitSha,
    model: row.model,
    cost: row.cost,
    stats: row.stats ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Nodo dell'albero/sidebar: quanto basta per renderizzare la navigazione. */
const treeNodeSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  parentId: z.uuid().nullable(),
  position: z.number().int(),
  sourcePath: z.string().nullable(),
  isManual: z.boolean(),
});

/**
 * Un cross-link risolto di una pagina: il `type` raggruppa la relazione
 * (implements/implemented_by/related), `slug`+`title` linkano la pagina target.
 */
const docPageLinkSchema = z.object({
  type: z.enum(["implements", "implemented_by", "related"]),
  slug: z.string(),
  title: z.string(),
});

/** Pagina completa: corpo markdown + metadati. */
const pageSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  parentId: z.uuid().nullable(),
  position: z.number().int(),
  sourcePath: z.string().nullable(),
  body: z.string(),
  isManual: z.boolean(),
  // commitSha della generazione di appartenenza; null per le pagine manuali.
  commitSha: z.string().nullable(),
  // Cross-link risolti a fine generazione; null se non calcolati (es. manuali
  // o generazioni del vecchio motore senza cross-link).
  links: z.array(docPageLinkSchema).nullable(),
  updatedAt: z.string(),
});

type DocPageRow = typeof docPages.$inferSelect;

/**
 * Serializza una pagina (DTO completo). `commitSha` è quello della generazione
 * di appartenenza; null per le pagine manuali (passare null o ometterlo).
 */
function toPage(row: DocPageRow, commitSha: string | null = null): z.infer<typeof pageSchema> {
  // `links` è jsonb (unknown a runtime): valida col contratto e scarta voci
  // malformate. Una colonna null o non-array → null (nessun cross-link).
  const parsedLinks = z.array(docPageLinkSchema).safeParse(row.links);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    parentId: row.parentId,
    position: row.position,
    sourcePath: row.sourcePath,
    body: row.body,
    isManual: row.isManual,
    commitSha,
    links: parsedLinks.success ? parsedLinks.data : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Uno "spazio" dell'hub: un repository che ha documentazione. */
const spaceSchema = z.object({
  repositoryId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  pageCount: z.number().int(),
  lastGenerationAt: z.string().nullable(),
  lastCommitSha: z.string().nullable(),
});

/**
 * Query di ricerca: `q` non vuota, cappata a 300 char (come la ricerca ticket).
 * `q` di soli spazi viene trattata come vuota a runtime (400).
 */
const searchQuerySchema = z.object({
  q: z.string().min(1).max(300),
});

/**
 * Un risultato di ricerca: la pagina (slug/title/kind) più l'estratto rilevante
 * e il punteggio. Nessuna colonna interna (embedding, ids di chunk, distanze
 * grezze) esce: solo ciò che serve a linkare la pagina e mostrare un'anteprima.
 */
const searchResultSchema = z.object({
  slug: z.string(),
  title: z.string(),
  kind: docPageKindSchema,
  snippet: z.string(),
  score: z.number(),
  source: z.enum(["semantic", "fulltext", "hybrid"]),
});


const createManualSchema = z.object({
  title: z.string().min(1).max(300),
  // Slug opzionale: assente = derivato dal titolo. Unico per progetto (409).
  slug: z.string().min(1).max(300).optional(),
  parentId: z.uuid().nullable().optional(),
  position: z.int().min(0).optional(),
  body: z.string().default(""),
});

const updateManualSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  parentId: z.uuid().nullable().optional(),
  position: z.int().min(0).optional(),
  body: z.string().optional(),
});

/**
 * Slug URL-safe dal titolo: minuscole, accenti rimossi, resto in trattini.
 * Stessa logica di routes/projects.ts; fallback fisso se non resta nulla.
 */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "pagina";
}

/**
 * Verifica che `parentId` esista come pagina dello stesso progetto: la
 * colonna parentId è una soft-FK senza vincolo cross-project, quindi va
 * validata a mano per evitare di puntare a pagine di altri progetti o
 * inesistenti.
 */
async function isParentInRepository(
  db: Db,
  repositoryId: string,
  parentId: string,
): Promise<boolean> {
  const [parent] = await db
    .select({ id: docPages.id })
    .from(docPages)
    .where(and(eq(docPages.id, parentId), eq(docPages.repositoryId, repositoryId)));
  return parent !== undefined;
}

/**
 * Route della documentazione (non-chat), registrate sotto /api.
 *
 * - Trigger generazione (solo admin) + stato (auth).
 * - Hub spazi, albero pagine, pagina singola (auth, sola lettura).
 * - CRUD pagine manuali (auth, member ok): solo le pagine `isManual` sono
 *   modificabili/eliminabili; le autogenerate sono protette.
 *
 * L'albero e la pagina mostrano SOLO la generazione corrente
 * (projects.currentDocGenerationId) più tutte le pagine manuali
 * (generationId null), che sopravvivono alle rigenerazioni.
 */
export async function docsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // --- M6.1: trigger generazione + stato ---------------------------------

  /**
   * Avvia una generazione manuale: inserisce un job `queued`. Idempotente sul
   * job attivo — se esiste già un job `queued`/`running` per il progetto, lo
   * restituisce invece di accodarne un secondo (evita doppie generazioni
   * concorrenti sullo stesso progetto). 404 se il progetto non esiste.
   *
   * Il provider AI non si sceglie più qui: la generazione eredita il provider
   * del progetto (projects.aiProviderId), risolto dal worker. Nessun pin a
   * livello di job.
   */
  app.post(
    "/repositories/:repositoryId/docs/generate",
    {
      preHandler: requireAdmin,
      schema: {
        params: repositoryIdParamsSchema,
        response: {
          200: jobSchema,
          202: jobSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { repositoryId } = request.params;

      const [repository] = await app.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!repository) return apiError(reply, 404, "repository_not_found", "Repository not found");

      // Job attivo già in coda/in esecuzione: lo riusiamo (idempotente).
      const [active] = await app.db
        .select()
        .from(docGenerationJobs)
        .where(
          and(
            eq(docGenerationJobs.repositoryId, repositoryId),
            or(eq(docGenerationJobs.status, "queued"), eq(docGenerationJobs.status, "running")),
          ),
        )
        .orderBy(desc(docGenerationJobs.createdAt))
        .limit(1);
      if (active) return reply.code(200).send(toJob(active));

      const [created] = await app.db
        .insert(docGenerationJobs)
        .values({ repositoryId, status: "queued", trigger: "manual" })
        .returning();
      if (!created) throw new Error("insert del job non ha restituito la riga");
      return reply.code(202).send(toJob(created));
    },
  );

  /**
   * Stato della documentazione del progetto: la generazione corrente (se c'è)
   * e l'ultimo job (qualunque stato). Null-safe quando non c'è ancora nulla.
   */
  app.get(
    "/repositories/:repositoryId/docs/status",
    {
      preHandler: requireAuth,
      schema: {
        params: repositoryIdParamsSchema,
        response: {
          200: z.object({
            generation: generationSchema.nullable(),
            latestJob: jobSchema.nullable(),
            pinnedProvider: pinnedProviderSchema.nullable(),
          }),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { repositoryId } = request.params;

      const [repository] = await app.db
        .select({ id: repositories.id, currentDocGenerationId: repositories.currentDocGenerationId })
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!repository) return apiError(reply, 404, "repository_not_found", "Repository not found");

      let generation: z.infer<typeof generationSchema> | null = null;
      // Pin esposto dalla generazione corrente (doc_generations.pinned_provider_id),
      // scritto dal worker dal provider del progetto. I job non portano più pin.
      let pinnedProviderId: string | null = null;
      if (repository.currentDocGenerationId) {
        const [gen] = await app.db
          .select()
          .from(docGenerations)
          .where(eq(docGenerations.id, repository.currentDocGenerationId));
        generation = gen ? toGeneration(gen) : null;
        pinnedProviderId = gen?.pinnedProviderId ?? null;
      }

      const [job] = await app.db
        .select()
        .from(docGenerationJobs)
        .where(eq(docGenerationJobs.repositoryId, repositoryId))
        .orderBy(desc(docGenerationJobs.createdAt))
        .limit(1);

      // Risolvi il provider bloccato: se l'id non esiste più (provider eliminato)
      // o non c'è alcun pin, esponi null.
      let pinnedProvider: z.infer<typeof pinnedProviderSchema> | null = null;
      if (pinnedProviderId) {
        const [provider] = await app.db
          .select({ id: aiProviders.id, label: aiProviders.label, kind: aiProviders.kind })
          .from(aiProviders)
          .where(eq(aiProviders.id, pinnedProviderId));
        pinnedProvider = provider ?? null;
      }

      return { generation, latestJob: job ? toJob(job) : null, pinnedProvider };
    },
  );

  // --- M6.2: hub spazi + albero + pagina ---------------------------------

  /**
   * Hub degli spazi: i progetti che hanno documentazione, cioè almeno una
   * pagina (autogenerata o manuale). Per ognuno: conteggio pagine e data/commit
   * dell'ultima generazione (terminata con successo).
   */
  app.get(
    "/docs/spaces",
    {
      preHandler: requireAuth,
      schema: { response: { 200: z.array(spaceSchema), ...authErrorResponses } },
    },
    async () => {
      // L'hub elenca TUTTI i repository, ognuno come "spazio" doc: è anche
      // l'entry point per generare la prima volta. Left join su doc_pages, quindi
      // un repository senza documentazione compare con pageCount 0 e
      // lastGenerationAt null. Il join sulle pagine conta solo quelle della
      // generazione corrente o manuali (generationId null): le pagine di
      // generazioni stale NON gonfiano il conteggio. Il join su docGenerations è
      // ristretto alla singola generazione corrente+succeeded, quindi
      // commitSha/finishedAt sono selezionabili direttamente.
      const rows = await app.db
        .select({
          repositoryId: repositories.id,
          slug: repositories.slug,
          name: repositories.name,
          pageCount: sql<number>`count(${docPages.id})::int`,
          lastGenerationAt: docGenerations.finishedAt,
          lastCommitSha: docGenerations.commitSha,
        })
        .from(repositories)
        .leftJoin(
          docPages,
          and(
            eq(docPages.repositoryId, repositories.id),
            or(
              eq(docPages.generationId, repositories.currentDocGenerationId),
              isNull(docPages.generationId),
            ),
          ),
        )
        .leftJoin(
          docGenerations,
          and(
            eq(docGenerations.id, repositories.currentDocGenerationId),
            eq(docGenerations.status, "succeeded"),
          ),
        )
        .groupBy(
          repositories.id,
          repositories.slug,
          repositories.name,
          docGenerations.finishedAt,
          docGenerations.commitSha,
        )
        .orderBy(asc(repositories.name));

      return rows.map((r) => ({
        repositoryId: r.repositoryId,
        slug: r.slug,
        name: r.name,
        pageCount: r.pageCount,
        lastGenerationAt: r.lastGenerationAt
          ? r.lastGenerationAt.toISOString()
          : null,
        lastCommitSha: r.lastCommitSha,
      }));
    },
  );

  /**
   * Albero delle pagine per la sidebar: le pagine della generazione corrente
   * più tutte le pagine manuali (generationId null). Ordinato per kind, poi
   * position/titolo. Le pagine di generazioni NON correnti sono escluse.
   */
  app.get(
    "/repositories/:repositoryId/docs/tree",
    {
      preHandler: requireAuth,
      schema: {
        params: repositoryIdParamsSchema,
        response: { 200: z.array(treeNodeSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { repositoryId } = request.params;

      const [repository] = await app.db
        .select({ id: repositories.id, currentDocGenerationId: repositories.currentDocGenerationId })
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!repository) return apiError(reply, 404, "repository_not_found", "Repository not found");

      // Generazione corrente OR manuale (generationId null). Senza generazione
      // corrente restano solo le manuali.
      const currentGen = repository.currentDocGenerationId;
      const genFilter = currentGen
        ? or(eq(docPages.generationId, currentGen), isNull(docPages.generationId))
        : isNull(docPages.generationId);

      const rows = await app.db
        .select({
          id: docPages.id,
          slug: docPages.slug,
          title: docPages.title,
          kind: docPages.kind,
          parentId: docPages.parentId,
          position: docPages.position,
          sourcePath: docPages.sourcePath,
          isManual: docPages.isManual,
        })
        .from(docPages)
        .where(and(eq(docPages.repositoryId, repositoryId), genFilter))
        .orderBy(asc(docPages.kind), asc(docPages.position), asc(docPages.title));

      return rows;
    },
  );

  /**
   * Pagina singola per slug (univoco per progetto): solo se appartiene alla
   * generazione corrente o è manuale. 404 altrimenti (anche per pagine di
   * generazioni vecchie). Include il commitSha della generazione per le pagine
   * autogenerate.
   */
  app.get(
    "/repositories/:repositoryId/docs/pages/:slug",
    {
      preHandler: requireAuth,
      schema: {
        params: slugParamsSchema,
        response: { 200: pageSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { repositoryId, slug } = request.params;

      const [repository] = await app.db
        .select({ id: repositories.id, currentDocGenerationId: repositories.currentDocGenerationId })
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!repository) return apiError(reply, 404, "repository_not_found", "Repository not found");

      // Con l'unicità slug per-generazione una pagina manuale e una della
      // generazione corrente possono condividere lo stesso slug: la query è
      // ristretta alle pagine VISIBILI (manuale OR generazione corrente) e
      // ordinata in modo deterministico, preferendo la pagina della generazione
      // corrente (autogenerata) alla manuale. `.limit(1)` rende l'esito stabile.
      const currentGen = repository.currentDocGenerationId;
      const visibleScope = currentGen
        ? or(eq(docPages.generationId, currentGen), isNull(docPages.generationId))
        : isNull(docPages.generationId);
      const [page] = await app.db
        .select()
        .from(docPages)
        .where(and(eq(docPages.repositoryId, repositoryId), eq(docPages.slug, slug), visibleScope))
        // generationId NOT NULL (corrente) prima della manuale (null): nulls last.
        .orderBy(sql`${docPages.generationId} DESC NULLS LAST`)
        .limit(1);
      if (!page) return apiError(reply, 404, "doc_page_not_found", "Documentation page not found");

      let commitSha: string | null = null;
      if (page.generationId) {
        const [gen] = await app.db
          .select({ commitSha: docGenerations.commitSha })
          .from(docGenerations)
          .where(eq(docGenerations.id, page.generationId));
        commitSha = gen?.commitSha ?? null;
      }

      return toPage(page, commitSha);
    },
  );

  // --- M6.4: ricerca (semantica + full-text) -----------------------------

  /**
   * Ricerca ibrida nei Docs del progetto: embedding della query → retrieval
   * semantico sui chunk (pgvector) UNITO al full-text su doc_pages.search_tsv.
   * Scope: generazione corrente + pagine manuali; le generazioni stale non
   * compaiono. `q` vuota/di soli spazi → 400. Vedi retrieveChunks per la regola
   * di merge/ranking (semantici prima, full-text-only dopo). Riusata dalla chat.
   */
  app.get(
    "/repositories/:repositoryId/docs/search",
    {
      preHandler: requireAuth,
      schema: {
        params: repositoryIdParamsSchema,
        querystring: searchQuerySchema,
        response: {
          200: z.array(searchResultSchema),
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { repositoryId } = request.params;
      const query = request.query.q.trim();
      // `q` di soli spazi passa il min(1) di Zod ma è semanticamente vuota.
      if (query.length === 0) {
        return apiError(reply, 400, "empty_query", "Search query must not be empty");
      }

      const [repository] = await app.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!repository) return apiError(reply, 404, "repository_not_found", "Repository not found");

      const results = await retrieveChunks(app.db, app.embeddingClient, repositoryId, query, {
        logger: request.log,
      });
      return results.map((r) => ({
        slug: r.slug,
        title: r.title,
        kind: r.kind,
        snippet: r.snippet,
        score: r.score,
        source: r.source,
      }));
    },
  );

  // --- M6.3: CRUD pagine manuali -----------------------------------------

  /**
   * Crea una pagina manuale (member ok): `isManual` true, `generationId` null,
   * `kind` "manual", autore = utente corrente. Slug derivato dal titolo se
   * assente; unico per progetto (409 in conflitto, anche con le autogenerate).
   */
  app.post(
    "/repositories/:repositoryId/docs/manual",
    {
      preHandler: requireAuth,
      schema: {
        params: repositoryIdParamsSchema,
        body: createManualSchema,
        response: {
          201: pageSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { repositoryId } = request.params;
      const { title, slug, parentId, position, body } = request.body;

      const [repository] = await app.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.id, repositoryId));
      if (!repository) return apiError(reply, 404, "repository_not_found", "Repository not found");

      // parentId è una soft-FK: deve risolvere a una pagina dello STESSO progetto.
      if (parentId != null && !(await isParentInRepository(app.db, repositoryId, parentId))) {
        return apiError(reply, 400, "invalid_parent", "Parent page not found in this project");
      }

      // Slug derivato cappato come quello fornito (max 300 char), per coerenza.
      const resolvedSlug = slug ?? slugify(title).slice(0, 300);

      try {
        const [created] = await app.db
          .insert(docPages)
          .values({
            repositoryId,
            generationId: null,
            kind: "manual",
            slug: resolvedSlug,
            title,
            parentId: parentId ?? null,
            position: position ?? 0,
            body,
            isManual: true,
            createdBy: request.user!.id,
          })
          .returning();
        if (!created) throw new Error("insert della pagina manuale non ha restituito la riga");
        return reply.code(201).send(toPage(created));
      } catch (error) {
        if (isUniqueViolation(error)) {
          return apiError(reply, 409, "doc_page_slug_conflict", "Slug already used in this project");
        }
        throw error;
      }
    },
  );

  /**
   * Aggiorna una pagina manuale (member ok): solo title/body/parentId/position.
   * Solo le pagine `isManual`: una pagina autogenerata risponde 404 (non è
   * "manual", quindi non esiste per questo endpoint). 404 anche se inesistente.
   */
  app.patch(
    "/repositories/:repositoryId/docs/manual/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: manualIdParamsSchema,
        body: updateManualSchema,
        response: { 200: pageSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { repositoryId, id } = request.params;
      const { title, parentId, position, body } = request.body;

      // parentId soft-FG: self-parent vietato e deve essere dello stesso progetto.
      if (parentId != null) {
        if (parentId === id) {
          return apiError(reply, 400, "invalid_parent", "A page cannot be its own parent");
        }
        if (!(await isParentInRepository(app.db, repositoryId, parentId))) {
          return apiError(reply, 400, "invalid_parent", "Parent page not found in this project");
        }
      }

      const updates: Partial<typeof docPages.$inferInsert> = {};
      if (title !== undefined) updates.title = title;
      if (parentId !== undefined) updates.parentId = parentId;
      if (position !== undefined) updates.position = position;
      if (body !== undefined) updates.body = body;

      // Drizzle rifiuta un update senza colonne: un PATCH vuoto è una lettura.
      const [row] =
        Object.keys(updates).length === 0
          ? await app.db
              .select()
              .from(docPages)
              .where(
                and(
                  eq(docPages.id, id),
                  eq(docPages.repositoryId, repositoryId),
                  eq(docPages.isManual, true),
                ),
              )
          : await app.db
              .update(docPages)
              .set(updates)
              .where(
                and(
                  eq(docPages.id, id),
                  eq(docPages.repositoryId, repositoryId),
                  eq(docPages.isManual, true),
                ),
              )
              .returning();
      if (!row) return apiError(reply, 404, "doc_page_not_found", "Manual page not found");

      return toPage(row);
    },
  );

  /**
   * Elimina una pagina manuale (member ok). Solo le pagine `isManual`: una
   * pagina autogenerata non viene toccata (404, non corrisponde al filtro).
   */
  app.delete(
    "/repositories/:repositoryId/docs/manual/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: manualIdParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { repositoryId, id } = request.params;
      const deleted = await app.db
        .delete(docPages)
        .where(
          and(
            eq(docPages.id, id),
            eq(docPages.repositoryId, repositoryId),
            eq(docPages.isManual, true),
          ),
        )
        .returning({ id: docPages.id });
      if (deleted.length === 0) {
        return apiError(reply, 404, "doc_page_not_found", "Manual page not found");
      }
      return reply.code(204).send(null);
    },
  );
}
