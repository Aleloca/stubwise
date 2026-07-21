import {
  createProjectSchema,
  projectSchema,
  repositorySchema,
  updateProjectSchema,
} from "@stubwise/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { aiProviders, projects, repositories } from "@stubwise/db";
import {
  authErrorResponses,
  errorSchema,
  generateIngestionKey,
  isUniqueViolation,
} from "./shared.js";
import { apiError } from "../errors.js";

/**
 * Tentativi massimi di insert prima di arrendersi sulla generazione dello
 * slug del progetto. In pratica non si raggiunge mai: serve solo a trasformare
 * un bug in un errore esplicito invece che in un loop infinito.
 */
const MAX_SLUG_ATTEMPTS = 100;

const idParamsSchema = z.object({ projectId: z.uuid() });

/**
 * Riepilogo di un repository nella lista/dettaglio progetto: solo i campi che
 * servono alla UI per elencare i repo del gruppo (id, nome, slug, provider). La
 * proiezione pubblica completa del repository vive sotto /api/repositories.
 */
const repositorySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  provider: repositorySchema.shape.provider,
});

/** Progetto con conteggio repository, per la lista. */
const projectListItemSchema = projectSchema.extend({
  repositoryCount: z.number().int(),
});

/** Progetto con l'elenco (sintetico) dei suoi repository, per il dettaglio. */
const projectDetailSchema = projectSchema.extend({
  repositories: z.array(repositorySummarySchema),
});

/**
 * Slug URL-safe dal nome: minuscole, accenti scomposti e rimossi, tutto il
 * resto collassato in trattini. Fallback fisso se non resta nulla.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "progetto";
}

type ProjectRow = typeof projects.$inferSelect;

/**
 * Proiezione pubblica del progetto (gruppo): campi elencati esplicitamente,
 * mai spread della riga. Porta le impostazioni di prodotto (provider AI,
 * auto-update docs) che valgono per tutti i repository del progetto.
 */
function toPublicProject(row: ProjectRow): z.infer<typeof projectSchema> {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    aiProviderId: row.aiProviderId,
    docAutoUpdate: row.docAutoUpdate,
    // Standup giornaliero (report attività): se true il worker genera ogni
    // notte lo standup dai commit del giorno dei repository del progetto.
    dailyReportEnabled: row.dailyReportEnabled,
    // Backlog di discovery: se true i ticket feedback/feature vengono deviati
    // all'intake del backlog invece di entrare nella pipeline fix.
    backlogEnabled: row.backlogEnabled,
    // Ingestion di prodotto (Fase 3): la chiave con cui gli SDK inviano
    // errori/feedback e il contatore ticket per-progetto, saliti dal repo.
    ingestionKey: row.ingestionKey,
    nextTicketNumber: row.nextTicketNumber,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Route dei progetti (gruppi), registrate sotto /api/projects. Lettura per
 * ogni utente autenticato; creazione, modifica ed eliminazione solo admin. Il
 * progetto raggruppa 1:N repository e porta le impostazioni di prodotto
 * (provider AI, auto-update docs).
 */
export async function projectRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      preHandler: requireAdmin,
      schema: {
        body: createProjectSchema,
        response: {
          201: projectSchema,
          400: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { name, description, aiProviderId, docAutoUpdate, dailyReportEnabled, backlogEnabled } =
        request.body;

      // Provider AI opzionale: se valorizzato deve riferire una riga esistente
      // (non serve enabled: è configurazione, l'enabled si valuta all'esecuzione).
      if (aiProviderId !== undefined && aiProviderId !== null) {
        const [aiProvider] = await app.db
          .select({ id: aiProviders.id })
          .from(aiProviders)
          .where(eq(aiProviders.id, aiProviderId));
        if (!aiProvider) {
          return apiError(reply, 400, "ai_provider_not_found", "AI provider not found");
        }
      }

      const baseSlug = slugify(name);
      // Unicità dello slug per insert-e-riprova: in caso di collisione si
      // aggiunge un suffisso numerico. Il vincolo unique del DB è l'arbitro
      // anche sotto richieste concorrenti.
      for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
        const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
        try {
          const [created] = await app.db
            .insert(projects)
            .values({
              name,
              slug,
              description: description ?? null,
              aiProviderId: aiProviderId ?? null,
              ...(docAutoUpdate !== undefined ? { docAutoUpdate } : {}),
              ...(dailyReportEnabled !== undefined ? { dailyReportEnabled } : {}),
              ...(backlogEnabled !== undefined ? { backlogEnabled } : {}),
              // Chiave di ingestion del progetto per gli SDK (Fase 3): 32 hex,
              // stesso generatore usato finora per i repository. UNIQUE: in caso
              // di collisione (astronomicamente improbabile) l'insert rilancia e
              // il giro dopo ne genera un'altra insieme allo slug.
              ingestionKey: generateIngestionKey(),
            })
            .returning();
          if (!created) throw new Error("insert del progetto non ha restituito la riga");
          return await reply.code(201).send(toPublicProject(created));
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new Error(`impossibile generare uno slug unico per "${baseSlug}"`);
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: { response: { 200: z.array(projectListItemSchema), ...authErrorResponses } },
    },
    async () => {
      const rows = await app.db.select().from(projects).orderBy(projects.createdAt);
      // Conteggio dei repository per progetto in una sola query, poi unito.
      const counts = await app.db
        .select({
          projectId: repositories.projectId,
          count: sql<number>`count(*)::int`,
        })
        .from(repositories)
        .groupBy(repositories.projectId);
      const countByProject = new Map(counts.map((c) => [c.projectId, c.count]));
      return rows.map((row) => ({
        ...toPublicProject(row),
        repositoryCount: countByProject.get(row.id) ?? 0,
      }));
    },
  );

  app.get(
    "/:projectId",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 200: projectDetailSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [row] = await app.db
        .select()
        .from(projects)
        .where(eq(projects.id, request.params.projectId));
      if (!row) return apiError(reply, 404, "project_not_found", "Project not found");
      const repos = await app.db
        .select({
          id: repositories.id,
          name: repositories.name,
          slug: repositories.slug,
          provider: repositories.provider,
        })
        .from(repositories)
        .where(eq(repositories.projectId, row.id))
        .orderBy(repositories.createdAt);
      return { ...toPublicProject(row), repositories: repos };
    },
  );

  app.patch(
    "/:projectId",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        body: updateProjectSchema,
        response: { 200: projectSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, description, aiProviderId, docAutoUpdate, dailyReportEnabled, backlogEnabled } =
        request.body;
      const updates: Partial<ProjectRow> = {};
      if (name !== undefined) updates.name = name;
      // null azzera la descrizione, una stringa la imposta; omesso lascia.
      if (description !== undefined) updates.description = description;
      // Toggle auto-aggiornamento Docs: omesso lo lascia invariato.
      if (docAutoUpdate !== undefined) updates.docAutoUpdate = docAutoUpdate;
      // Toggle standup giornaliero (report attività): omesso lo lascia invariato.
      if (dailyReportEnabled !== undefined) updates.dailyReportEnabled = dailyReportEnabled;
      // Toggle backlog di discovery: omesso lo lascia invariato.
      if (backlogEnabled !== undefined) updates.backlogEnabled = backlogEnabled;
      // Provider AI del progetto (Docs e fix). null lo azzera (automatico); un
      // uuid deve riferire una riga ai_providers esistente; omesso lo lascia.
      if (aiProviderId !== undefined) {
        if (aiProviderId !== null) {
          const [aiProvider] = await app.db
            .select({ id: aiProviders.id })
            .from(aiProviders)
            .where(eq(aiProviders.id, aiProviderId));
          if (!aiProvider) {
            return apiError(reply, 400, "ai_provider_not_found", "AI provider not found");
          }
        }
        updates.aiProviderId = aiProviderId;
      }

      // Drizzle rifiuta un update senza colonne: un PATCH vuoto è una lettura.
      if (Object.keys(updates).length > 0) {
        const [updated] = await app.db
          .update(projects)
          .set(updates)
          .where(eq(projects.id, request.params.projectId))
          .returning();
        if (!updated) return apiError(reply, 404, "project_not_found", "Project not found");
        return toPublicProject(updated);
      }

      const [row] = await app.db
        .select()
        .from(projects)
        .where(eq(projects.id, request.params.projectId));
      if (!row) return apiError(reply, 404, "project_not_found", "Project not found");
      return toPublicProject(row);
    },
  );

  // Eliminazione del progetto (solo admin). Il DB cancella in cascata i
  // repository del progetto (e con essi ticket/milestone/docs): nessuna guard
  // di "non se ha repository", coerentemente con la cascade definita sullo
  // schema. Risponde 204 No Content, o 404 se il progetto non esiste.
  app.delete(
    "/:projectId",
    {
      preHandler: requireAdmin,
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const [deleted] = await app.db
        .delete(projects)
        .where(eq(projects.id, request.params.projectId))
        .returning({ id: projects.id });
      if (!deleted) return apiError(reply, 404, "project_not_found", "Project not found");
      return reply.code(204).send(null);
    },
  );
}
