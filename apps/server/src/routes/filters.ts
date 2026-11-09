import { pinnedTaskFilters, taskFilters, type Db } from "@stubwise/db";
import {
  filterPatchBodySchema,
  newFilterBodySchema,
  parseCriteria,
  savedFilterViewSchema,
  type SavedFilterView,
} from "@stubwise/shared";
import { and, asc, eq, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { SessionUser } from "../auth/session.js";
import { apiError } from "../errors.js";
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

const isFullAdmin = (viewer: Viewer) => viewer.instancePermissions.has("instance.full_admin");

/** I filtri che `viewer` vede: i suoi e i pubblici. */
const visibleTo = (viewer: Viewer) => or(eq(taskFilters.ownerId, viewer.id), eq(taskFilters.visibility, "public"))!;

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

async function visibleFilter(db: Db, viewer: Viewer, id: string) {
  const [row] = await db
    .select()
    .from(taskFilters)
    .where(and(eq(taskFilters.id, id), visibleTo(viewer)));
  return row ?? null;
}

const idParams = z.object({ id: z.uuid() });

/** Quanti filtri può avere una persona (fix della review della fetta 3). */
export const MAX_FILTERS_PER_PERSON = 200;

/** Un lock di transazione per persona e tabella: serializza le sue scritture concorrenti. */
async function lockPerson(tx: Pick<Db, "execute">, scope: string, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${scope}:${userId}`}))`);
}

export async function filterRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

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
      schema: { body: newFilterBodySchema, response: { 201: savedFilterViewSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const viewer = request.user!;
      // Un tetto per persona (fix della review della fetta 3), contato sotto
      // un lock della persona: due creazioni concorrenti non lo sfondano.
      const row = await app.db.transaction(async (tx) => {
        await lockPerson(tx, "task_filters", viewer.id);
        const [{ count } = { count: 0 }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(taskFilters)
          .where(eq(taskFilters.ownerId, viewer.id));
        if (count >= MAX_FILTERS_PER_PERSON) return null;
        const [created] = await tx
          .insert(taskFilters)
          .values({ ...request.body, ownerId: viewer.id })
          .returning();
        return created!;
      });
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
        response: { 200: savedFilterViewSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const viewer = request.user!;
      const row = await visibleFilter(app.db, viewer, request.params.id);
      if (!row) return apiError(reply, 404, "not_found", "Filter not found");
      if (row.ownerId !== viewer.id && !isFullAdmin(viewer)) {
        return apiError(reply, 403, "forbidden", "Only the author or a full admin edits a filter");
      }
      const patch = Object.fromEntries(Object.entries(request.body).filter(([, v]) => v !== undefined));
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
      const viewer = request.user!;
      const row = await visibleFilter(app.db, viewer, request.params.id);
      if (!row) return apiError(reply, 404, "not_found", "Filter not found");
      if (row.ownerId !== viewer.id && !isFullAdmin(viewer)) {
        return apiError(reply, 403, "forbidden", "Only the author or a full admin deletes a filter");
      }
      // I fissati di tutti se ne vanno in cascata (`pinned_task_filters.filter_id`).
      await app.db.delete(taskFilters).where(eq(taskFilters.id, row.id));
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
