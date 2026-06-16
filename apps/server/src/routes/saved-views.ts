import { ticketPrioritySchema, ticketStatusSchema, ticketTypeSchema } from "@stubwise/shared";
import { eq, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAuth } from "../auth/session.js";
import { savedViews } from "@stubwise/db";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema, isUniqueViolation } from "./shared.js";

/**
 * Criteri di filtraggio della lista ticket persistibili in una vista salvata.
 * Tutti opzionali e `.strict()`: chiavi non previste vengono rifiutate per non
 * salvare spazzatura nel jsonb (e per non confondere il client che li riapplica).
 */
const savedViewFiltersSchema = z
  .object({
    projectId: z.uuid().optional(),
    status: ticketStatusSchema.optional(),
    type: ticketTypeSchema.optional(),
    priority: ticketPrioritySchema.optional(),
    assigneeId: z.uuid().optional(),
    milestoneId: z.uuid().optional(),
    q: z.string().min(1).max(300).optional(),
  })
  .strict();

/** Proiezione pubblica di una vista salvata, con `isOwn` relativo al chiamante. */
const savedViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  filters: savedViewFiltersSchema,
  shared: z.boolean(),
  ownerId: z.uuid(),
  isOwn: z.boolean(),
  createdAt: z.iso.datetime(),
});

const nameSchema = z.string().min(1).max(120);

const createSavedViewBodySchema = z.object({
  name: nameSchema,
  filters: savedViewFiltersSchema,
  shared: z.boolean().optional(),
});

const updateSavedViewBodySchema = z.object({
  name: nameSchema.optional(),
  filters: savedViewFiltersSchema.optional(),
  shared: z.boolean().optional(),
});

const idParamsSchema = z.object({ id: z.uuid() });

type SavedViewRow = typeof savedViews.$inferSelect;

/** Proiezione pubblica: `isOwn` deriva dal confronto con l'utente corrente. */
function toPublicSavedView(row: SavedViewRow, me: string): z.infer<typeof savedViewSchema> {
  return {
    id: row.id,
    name: row.name,
    // Il jsonb tipizza status/type/priority come string; i valori salvati sono
    // gia stati validati dallo zod schema, che li ristringe agli enum.
    filters: row.filters as z.infer<typeof savedViewFiltersSchema>,
    shared: row.shared,
    ownerId: row.ownerId,
    isOwn: row.ownerId === me,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Viste salvate dei filtri della lista ticket, registrate sotto
 * /api/saved-views. Tutte dietro requireAuth. Una vista è privata al suo
 * proprietario salvo `shared = true`, che la rende leggibile a tutti; solo il
 * proprietario puo modificarla o cancellarla.
 */
export async function savedViewRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/",
    {
      preHandler: requireAuth,
      schema: {
        body: createSavedViewBodySchema,
        response: { 201: savedViewSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const me = request.user!.id;
      const { name, filters, shared } = request.body;
      try {
        const [created] = await app.db
          .insert(savedViews)
          .values({ ownerId: me, name, filters, ...(shared !== undefined ? { shared } : {}) })
          .returning();
        if (!created) throw new Error("insert della vista salvata non ha restituito la riga");
        return await reply.code(201).send(toPublicSavedView(created, me));
      } catch (error) {
        if (isUniqueViolation(error)) {
          return apiError(reply, 409, "view_exists", "A saved view with this name already exists");
        }
        throw error;
      }
    },
  );

  app.get(
    "/",
    {
      preHandler: requireAuth,
      schema: { response: { 200: z.array(savedViewSchema), ...authErrorResponses } },
    },
    async (request) => {
      const me = request.user!.id;
      const rows = await app.db
        .select()
        .from(savedViews)
        // Le proprie (a prescindere da shared) + le condivise di chiunque.
        .where(or(eq(savedViews.ownerId, me), eq(savedViews.shared, true)))
        // Le proprie in cima (CASE su ownerId), poi per nome.
        .orderBy(
          sql`case when ${savedViews.ownerId} = ${me} then 0 else 1 end`,
          savedViews.name,
        );
      return rows.map((row) => toPublicSavedView(row, me));
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: updateSavedViewBodySchema,
        response: {
          200: savedViewSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const me = request.user!.id;
      const { name, filters, shared } = request.body;

      const updates: Partial<typeof savedViews.$inferInsert> = {};
      if (name !== undefined) updates.name = name;
      if (filters !== undefined) updates.filters = filters;
      if (shared !== undefined) updates.shared = shared;

      if (Object.keys(updates).length === 0) {
        return apiError(reply, 400, "no_fields", "Provide at least one field to update");
      }

      const id = request.params.id;
      const [existing] = await app.db.select().from(savedViews).where(eq(savedViews.id, id));
      if (!existing) return apiError(reply, 404, "view_not_found", "Saved view not found");
      if (existing.ownerId !== me) {
        return apiError(reply, 403, "forbidden", "Only the owner can modify this saved view");
      }

      try {
        const [updated] = await app.db
          .update(savedViews)
          .set(updates)
          .where(eq(savedViews.id, id))
          .returning();
        if (!updated) return apiError(reply, 404, "view_not_found", "Saved view not found");
        return toPublicSavedView(updated, me);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return apiError(reply, 409, "view_exists", "A saved view with this name already exists");
        }
        throw error;
      }
    },
  );

  app.delete(
    "/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const me = request.user!.id;
      const id = request.params.id;
      const [existing] = await app.db.select().from(savedViews).where(eq(savedViews.id, id));
      if (!existing) return apiError(reply, 404, "view_not_found", "Saved view not found");
      if (existing.ownerId !== me) {
        return apiError(reply, 403, "forbidden", "Only the owner can delete this saved view");
      }
      await app.db.delete(savedViews).where(eq(savedViews.id, id));
      return reply.code(204).send(null);
    },
  );
}
