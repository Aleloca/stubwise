import { registerPersonMask } from "../services/people-known.js";
import { pinnedTaskFilters, taskFilters } from "@stubwise/db";
import {
  filterPatchBodySchema,
  newFilterRequestSchema,
  parseCriteria,
  savedFilterViewSchema,
  type SavedFilterView,
} from "@stubwise/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { SessionUser } from "../auth/session.js";
import { apiError } from "../errors.js";
import {
  createTaskFilter,
  deleteTaskFilter,
  isFullAdmin,
  lockPerson,
  MAX_FILTERS_PER_PERSON,
  resolveCriteriaPlaceholders,
  visibleFilter,
  visibleTo,
} from "../services/task-filters.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * I filtri salvati dell'app nuova (integrazione area 2, fetta 3). Regole del
 * prototipo (`data/api.ts`, `data/api-mutations.ts`):
 * - si vedono i propri e i pubblici; un privato d'altri risponde 404 come
 *   uno che non esiste, a chiunque (anche a un full admin);
 * - modifica ed eliminazione: l'autore o un full admin (un filtro senza
 *   autore, cioè di esempio, solo un full admin);
 * - fissare è personale; eliminare un filtro lo toglie dai fissati di tutti
 *   (cascata), e un fissato che non si vede più non si elenca.
 * Un filtro pubblico non allarga niente: chi lo apre interroga `/api/tasks`,
 * che mostra solo le task che vede già.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;


function viewOf(row: typeof taskFilters.$inferSelect, viewer: Viewer): SavedFilterView {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    visibility: row.visibility,
    // Criteri scritti da una versione vecchia si leggono lo stesso: si tiene ciò che ha la forma giusta.
    criteria: parseCriteria(row.criteria) ?? {},
    view: row.view,
    groupBy: row.groupBy,
    canEdit: row.ownerId === viewer.id || isFullAdmin(viewer),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const idParams = z.object({ id: z.uuid() });

// Il tetto e il lock stanno nel servizio (li usa anche l'esecutore delle azioni di Claude).
export { MAX_FILTERS_PER_PERSON };

/** Registro, A11 r.1414: le chiavi delle risposte che portano una persona. */
// `assigneeIds` dei criteri (scelta A di 46): lo stesso masker di `ownerId`; `none` non è un id e resta.
const FILTER_PERSON_KEYS: ReadonlySet<string> = new Set(["ownerId", "assigneeIds"]);

/** Un segnaposto nei criteri che non si risolve col filtro d'origine (registro, A11 r.1414). */
const PLACEHOLDER_CRITERIA = "criteria: a placeholder needs the saved filter it comes from";

export async function filterRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  // Registro, A11 r.1414: chi guarda non riceve l'id di chi non conosce.
  registerPersonMask(app, FILTER_PERSON_KEYS);

  app.get(
    "/filters",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: z.array(savedFilterViewSchema), ...authErrorResponses } },
    },
    async (request) => {
      const viewer = request.user!;
      const rows = await app.db
        .select()
        .from(taskFilters)
        .where(visibleTo(viewer))
        .orderBy(asc(taskFilters.createdAt), asc(taskFilters.name), asc(taskFilters.id));
      return rows.map((r) => viewOf(r, viewer));
    },
  );

  app.get(
    "/filters/:id",
    {
      config: { access: { kind: "user" } },
      schema: { params: idParams, response: { 200: savedFilterViewSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const row = await visibleFilter(app.db, request.user!, request.params.id);
      if (!row) return apiError(reply, 404, "not_found", "Filter not found");
      return viewOf(row, request.user!);
    },
  );

  app.post(
    "/filters",
    {
      config: { access: { kind: "user" } },
      schema: { body: newFilterRequestSchema, response: { 201: savedFilterViewSchema, 400: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const viewer = request.user!;
      const { savedFilterId, ...body } = request.body;
      const source = savedFilterId ? await visibleFilter(app.db, viewer, savedFilterId) : null;
      const criteria = await resolveCriteriaPlaceholders(app.db, viewer, body.criteria, source);
      if (criteria === "invalid") return apiError(reply, 400, "invalid", PLACEHOLDER_CRITERIA);
      const row = await createTaskFilter(app.db, viewer, { ...body, criteria });
      if (!row) return apiError(reply, 400, "too_many_filters", `At most ${MAX_FILTERS_PER_PERSON} filters per person`);
      return reply.code(201).send(viewOf(row, viewer));
    },
  );

  app.patch(
    "/filters/:id",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: idParams,
        body: filterPatchBodySchema,
        response: { 200: savedFilterViewSchema, 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const viewer = request.user!;
      const row = await visibleFilter(app.db, viewer, request.params.id);
      if (!row) return apiError(reply, 404, "not_found", "Filter not found");
      if (row.ownerId !== viewer.id && !isFullAdmin(viewer)) {
        return apiError(reply, 403, "forbidden", "Only the author or a full admin edits a filter");
      }
      // Una PATCH senza `criteria` li lascia invariati, con gli id veri; con
      // dei segnaposto, tornano gli id del filtro stesso (I-6).
      const criteria = request.body.criteria === undefined ? undefined : await resolveCriteriaPlaceholders(app.db, viewer, request.body.criteria, row);
      if (criteria === "invalid") return apiError(reply, 400, "invalid", PLACEHOLDER_CRITERIA);
      const patch = Object.fromEntries(Object.entries({ ...request.body, criteria }).filter(([, v]) => v !== undefined));
      const [updated] = await app.db
        .update(taskFilters)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(taskFilters.id, row.id))
        .returning();
      return viewOf(updated!, viewer);
    },
  );

  app.delete(
    "/filters/:id",
    {
      config: { access: { kind: "user" } },
      schema: { params: idParams, response: { 204: z.null(), 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const result = await deleteTaskFilter(app.db, request.user!, request.params.id);
      if (result === "not_found") return apiError(reply, 404, "not_found", "Filter not found");
      if (result === "forbidden") return apiError(reply, 403, "forbidden", "Only the author or a full admin deletes a filter");
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/me/pinned-filters",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: z.array(z.uuid()), ...authErrorResponses } },
    },
    async (request) => {
      const viewer = request.user!;
      const rows = await app.db
        .select({ id: pinnedTaskFilters.filterId })
        .from(pinnedTaskFilters)
        .innerJoin(taskFilters, eq(taskFilters.id, pinnedTaskFilters.filterId))
        .where(and(eq(pinnedTaskFilters.userId, viewer.id), visibleTo(viewer)))
        .orderBy(asc(pinnedTaskFilters.position), asc(pinnedTaskFilters.filterId));
      return rows.map((r) => r.id);
    },
  );

  app.put(
    "/me/pinned-filters/:id",
    {
      config: { access: { kind: "user" } },
      schema: { params: idParams, response: { 204: z.null(), 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const viewer = request.user!;
      const row = await visibleFilter(app.db, viewer, request.params.id);
      if (!row) return apiError(reply, 404, "not_found", "Filter not found");
      // In coda; già fissato resta dov'è. La posizione si legge sotto un lock
      // della persona (fix della review della fetta 3): pin concorrenti non
      // prendono la stessa.
      await app.db.transaction(async (tx) => {
        await lockPerson(tx, "pinned_task_filters", viewer.id);
        await tx
          .insert(pinnedTaskFilters)
          .values({
            userId: viewer.id,
            filterId: row.id,
            position: sql`(select coalesce(max(${pinnedTaskFilters.position}), -1) + 1 from ${pinnedTaskFilters} where ${pinnedTaskFilters.userId} = ${viewer.id})`,
          })
          .onConflictDoNothing();
      });
      return reply.code(204).send(null);
    },
  );

  app.delete(
    "/me/pinned-filters/:id",
    {
      config: { access: { kind: "user" } },
      schema: { params: idParams, response: { 204: z.null(), ...authErrorResponses } },
    },
    async (request, reply) => {
      await app.db
        .delete(pinnedTaskFilters)
        .where(and(eq(pinnedTaskFilters.userId, request.user!.id), eq(pinnedTaskFilters.filterId, request.params.id)));
      return reply.code(204).send(null);
    },
  );
}
