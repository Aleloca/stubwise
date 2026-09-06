import {
  createProjectSchema,
  prReviewSummarySchema,
  projectDetailSchema,
  projectListItemSchema,
  projectPulseSummarySchema,
  projectSchema,
  projectTimelineKindSchema,
  projectTimelineSchema,
  updateProjectSchema,
} from "@stubwise/shared";
import { summarizeProject, type ProjectPulseSummary } from "@stubwise/notifications";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/session.js";
import { aiProviders, projectFollows, projects, repositories } from "@stubwise/db";
import {
  authErrorResponses,
  errorSchema,
  generateIngestionKey,
  isUniqueViolation,
} from "./shared.js";
import { apiError } from "../errors.js";
import {
  TIMELINE_MAX_DAYS,
  buildProjectTimeline,
  canViewProject,
  listProjectReviews,
  resolveTimelineWindow,
} from "../services/project-timeline.js";

/**
 * Tentativi massimi di insert prima di arrendersi sulla generazione dello
 * slug del progetto. In pratica non si raggiunge mai: serve solo a trasformare
 * un bug in un errore esplicito invece che in un loop infinito.
 */
const MAX_SLUG_ATTEMPTS = 100;

const idParamsSchema = z.object({ projectId: z.uuid() });

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

/**
 * Ordinamento di `GET /api/projects/pulse`: prima chi ha `waitingForYou`
 * (una decisione del viewer ferma il progetto), poi chi ha `running` (lavoro
 * in corso, meno urgente di una decisione ma più di uno fermo), infine per
 * `idleDays` decrescente (il più fermo in cima, fra pari).
 *
 * SORT applicativo dopo aver raccolto i riepiloghi, non un `ORDER BY` SQL: i
 * progetti che un viewer segue (il caso comune, quello per cui questa rotta
 * esiste) sono poche unità — un `Array.sort` su una manciata di oggetti è più
 * semplice da leggere e mantenere di un `ORDER BY` su colonne calcolate da tre
 * query diverse, e non ci sarebbe comunque un modo di farlo in UNA query sola
 * (`summarizeProject` ne fa già più di una per progetto).
 */
function pulseOrder(a: ProjectPulseSummary, b: ProjectPulseSummary): number {
  const rank = (s: ProjectPulseSummary): [number, number, number] => [
    s.waitingForYou.length > 0 ? 0 : 1,
    s.running.length > 0 ? 0 : 1,
    -s.idleDays,
  ];
  const [ra, rb] = [rank(a), rank(b)];
  for (let i = 0; i < ra.length; i++) {
    const diff = ra[i]! - rb[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
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
    // Pulse proattivo: se attivo, quando il progetto è fermo il poller propone
    // voci del backlog da cui ripartire, ogni `pulseEveryDays` giorni.
    // `pulseLastSentAt` NON fa parte della proiezione: è stato interno del
    // poller (il gate di idempotenza), non un'impostazione.
    pulseEnabled: row.pulseEnabled,
    pulseEveryDays: row.pulseEveryDays,
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
      const {
        name,
        description,
        aiProviderId,
        docAutoUpdate,
        dailyReportEnabled,
        backlogEnabled,
        pulseEnabled,
        pulseEveryDays,
      } = request.body;

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
              ...(pulseEnabled !== undefined ? { pulseEnabled } : {}),
              ...(pulseEveryDays !== undefined ? { pulseEveryDays } : {}),
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

  /**
   * IL "polso" dei progetti: chi aspetta cosa, cosa gira, cosa langue —
   * l'app mobile la usa come vista di apertura (Fase 4).
   *
   * ⚠️ DEVE restare registrata PRIMA di `GET /:projectId`: Fastify sceglie la
   * rotta più specifica quando ce n'è una, ma qui "/pulse" e "/:projectId" sono
   * ENTRAMBE candidate per lo stesso path — se questa venisse dichiarata dopo,
   * "pulse" verrebbe letto come `projectId` e fallirebbe la validazione UUID
   * dei `params` (400), mai raggiungendo questo handler. Un test in
   * `projects.test.ts` lo verifica chiamando `/api/projects/pulse` e
   * controllando che NON torni l'errore di validazione di `/:projectId`.
   *
   * Un `member` vede solo i progetti che segue (`project_follows`, stesso
   * criterio di `/api/me/follows`); un `admin` li vede tutti — non ha bisogno
   * di seguirli per doverne sapere lo stato.
   */
  app.get(
    "/pulse",
    {
      preHandler: requireAuth,
      schema: { response: { 200: z.array(projectPulseSummarySchema), ...authErrorResponses } },
    },
    async (request) => {
      const viewer = { userId: request.user!.id, role: request.user!.role };

      const projectIds =
        viewer.role === "admin"
          ? (await app.db.select({ id: projects.id }).from(projects)).map((row) => row.id)
          : (
              await app.db
                .select({ id: projectFollows.projectId })
                .from(projectFollows)
                .where(eq(projectFollows.userId, viewer.userId))
            ).map((row) => row.id);

      const summaries = (
        await Promise.all(projectIds.map((id) => summarizeProject(app.db, id, viewer)))
      ).filter((summary): summary is ProjectPulseSummary => summary !== null);

      return summaries.sort(pulseOrder);
    },
  );

  /**
   * Le review AI di PR del progetto (Fase 5): la PRIMA lettura di `pr_reviews`
   * da un'API. Serve alla timeline (verdetto accanto alla PR) e all'app.
   *
   * Registrata PRIMA di `GET /:projectId` per coerenza con `/pulse` qui sopra.
   * Il path ha un suffisso letterale (`/reviews`) e non collide davvero con la
   * rotta parametrica, ma l'ordine "letterali prima della `:id`" è la regola di
   * questo file e non si fa un'eccezione per ricordarsi che era innocua.
   */
  app.get(
    "/:projectId/reviews",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
        response: {
          200: z.array(prReviewSummarySchema),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const viewer = { userId: request.user!.id, role: request.user!.role };
      if (!(await canViewProject(app.db, request.params.projectId, viewer))) {
        return apiError(reply, 404, "project_not_found", "Project not found");
      }
      return listProjectReviews(app.db, request.params.projectId, request.query.limit ?? 50);
    },
  );

  /**
   * LA TIMELINE DI PROGETTO (Fase 5): ticket, milestone, PR, report, decisioni
   * e brief fusi in un racconto ordinato. Alimenta la pagina web "Roadmap".
   *
   * `from`/`to` sono ISO 8601 e hanno default lato server (ultime 4 settimane);
   * `kinds` è un elenco separato da virgole per filtrare i tipi di voce. La
   * finestra non può superare i 180 giorni: sopra è un 400, non una risposta
   * enorme costruita scandendo lo storico intero.
   *
   * ACL come `/pulse`: un member vede solo i progetti che segue, un admin
   * tutti. "Non seguito" e "inesistente" rispondono entrambi 404.
   */
  app.get(
    "/:projectId/timeline",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        querystring: z.object({
          from: z.string().optional(),
          to: z.string().optional(),
          kinds: z.string().optional(),
        }),
        response: {
          200: projectTimelineSchema,
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const viewer = { userId: request.user!.id, role: request.user!.role };
      if (!(await canViewProject(app.db, request.params.projectId, viewer))) {
        return apiError(reply, 404, "project_not_found", "Project not found");
      }

      const resolved = resolveTimelineWindow(request.query);
      if (!resolved.ok) {
        return apiError(
          reply,
          400,
          resolved.reason,
          resolved.reason === "window_too_large"
            ? `The timeline window cannot exceed ${TIMELINE_MAX_DAYS} days`
            : "Invalid from/to range",
        );
      }

      // `kinds` vuoto (`?kinds=`) NON è "nessun tipo": è un parametro che il
      // client ha mandato senza valore, e la risposta giusta è la timeline
      // intera, non una lista vuota che sembra un progetto senza storia.
      let kinds: Set<string> | undefined;
      if (request.query.kinds !== undefined && request.query.kinds.trim() !== "") {
        const requested = request.query.kinds.split(",").map((value) => value.trim());
        const unknown = requested.filter(
          (value) => !projectTimelineKindSchema.options.includes(value as never),
        );
        if (unknown.length > 0) {
          return apiError(reply, 400, "invalid_kinds", `Unknown timeline kinds: ${unknown.join(", ")}`);
        }
        kinds = new Set(requested);
      }

      const entries = await buildProjectTimeline(
        app.db,
        request.params.projectId,
        resolved.window,
        kinds,
      );
      return {
        from: resolved.window.from.toISOString(),
        to: resolved.window.to.toISOString(),
        entries,
      };
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
      const {
        name,
        description,
        aiProviderId,
        docAutoUpdate,
        dailyReportEnabled,
        backlogEnabled,
        pulseEnabled,
        pulseEveryDays,
      } = request.body;
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
      // Toggle e cadenza del pulse proattivo: omessi li lasciano invariati. Il
      // range 1..30 lo ha già applicato lo schema del corpo (400), e il CHECK
      // del DB resta l'arbitro per chi scrive senza passare da qui.
      if (pulseEnabled !== undefined) updates.pulseEnabled = pulseEnabled;
      if (pulseEveryDays !== undefined) updates.pulseEveryDays = pulseEveryDays;
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
