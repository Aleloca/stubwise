import { departmentMembers, departments, tickets, users } from "@stubwise/db";
import { departmentColorTokenSchema, departmentViewSchema, type DepartmentView } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteAccess } from "../auth/access.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Reparti (integrazione area 2, fetta 1): la pagina Reparti
 * dell'amministrazione del prototipo (`pages/admin/DepartmentsPage.tsx`):
 * nome, colore, persone. Letti da ogni persona (servono a ogni task e ai
 * selettori), gestiti con `departments.manage`. Il ripiego («General») si
 * rinomina ma non si elimina: è dove nasce una task senza autore umano.
 */

const MANAGE: RouteAccess = { kind: "instance", permission: "departments.manage" };
const idParamsSchema = z.object({ id: z.uuid() });
const nameSchema = z.string().trim().min(1).max(80);

type DepartmentRow = typeof departments.$inferSelect;

function toView(row: DepartmentRow): DepartmentView {
  return {
    id: row.id,
    name: row.name,
    colorToken: row.colorToken as DepartmentView["colorToken"],
    isDefault: row.isDefault,
  };
}

export async function departmentRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /** Un altro reparto ha già quel nome (senza distinguere maiuscole). */
  async function nameTaken(name: string, except?: string): Promise<boolean> {
    const rows = await app.db
      .select({ id: departments.id })
      .from(departments)
      .where(sql`lower(${departments.name}) = lower(${name})`);
    return rows.some((r) => r.id !== except);
  }

  app.get(
    "/",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: z.array(departmentViewSchema), ...authErrorResponses } },
    },
    async () => {
      const rows = await app.db
        .select()
        .from(departments)
        .orderBy(desc(departments.isDefault), asc(departments.name));
      return rows.map(toView);
    },
  );

  app.post(
    "/",
    {
      config: { access: MANAGE },
      schema: {
        body: z.object({ name: nameSchema, colorToken: departmentColorTokenSchema }),
        response: { 201: departmentViewSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { name, colorToken } = request.body;
      if (await nameTaken(name)) {
        return apiError(reply, 409, "department_name_taken", "A department with this name already exists");
      }
      const [row] = await app.db.insert(departments).values({ name, colorToken }).returning();
      return reply.code(201).send(toView(row!));
    },
  );

  app.patch(
    "/:id",
    {
      config: { access: MANAGE },
      schema: {
        params: idParamsSchema,
        body: z.object({
          name: nameSchema.optional(),
          colorToken: departmentColorTokenSchema.optional(),
          // L'insieme INTERO delle persone del reparto.
          memberIds: z.array(z.uuid()).max(2000).optional(),
        }),
        response: {
          200: departmentViewSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { name, colorToken, memberIds } = request.body;
      const [current] = await app.db.select().from(departments).where(eq(departments.id, id));
      if (!current) return apiError(reply, 404, "not_found", "Department not found");
      if (name !== undefined && (await nameTaken(name, id))) {
        return apiError(reply, 409, "department_name_taken", "A department with this name already exists");
      }
      const next = memberIds === undefined ? undefined : [...new Set(memberIds)];
      if (next && next.length > 0) {
        const found = await app.db.select({ id: users.id }).from(users).where(inArray(users.id, next));
        if (found.length !== next.length) {
          return apiError(reply, 400, "person_not_found", "One of the people does not exist");
        }
      }
      const updated = await app.db.transaction(async (tx) => {
        const patch: Partial<DepartmentRow> = {};
        if (name !== undefined) patch.name = name;
        if (colorToken !== undefined) patch.colorToken = colorToken;
        const [row] =
          Object.keys(patch).length > 0
            ? await tx.update(departments).set(patch).where(eq(departments.id, id)).returning()
            : [current];
        if (next) {
          await tx
            .delete(departmentMembers)
            .where(
              next.length > 0
                ? and(eq(departmentMembers.departmentId, id), notInArray(departmentMembers.userId, next))
                : eq(departmentMembers.departmentId, id),
            );
          // Chi entra lo riceve PER ULTIMO fra i suoi reparti: il suo «primo
          // reparto» (dove nascono le sue task) non cambia.
          for (const userId of next) {
            await tx.execute(sql`
              insert into "department_members" ("department_id", "user_id", "position")
              select ${id}, ${userId}, coalesce(max("position") + 1, 0)
              from "department_members" where "user_id" = ${userId}
              on conflict do nothing
            `);
          }
        }
        return row!;
      });
      return toView(updated);
    },
  );

  app.delete(
    "/:id",
    {
      config: { access: MANAGE },
      schema: {
        params: idParamsSchema,
        querystring: z.object({ moveTasksTo: z.uuid().optional() }),
        response: { 204: z.null(), 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { moveTasksTo } = request.query;
      const [current] = await app.db.select().from(departments).where(eq(departments.id, id));
      if (!current) return apiError(reply, 404, "not_found", "Department not found");
      if (current.isDefault) {
        return apiError(reply, 400, "department_is_default", "The fallback department cannot be deleted");
      }
      // Conteggio e trasloco nella stessa transazione, col reparto bloccato:
      // una task assegnata al reparto nel frattempo si sposta anche lei, o il
      // controllo la vede — mai un 500 dalla FK.
      const outcome = await app.db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from "departments" where "id" = ${id} for update`);
        const [{ count }] = (await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(tickets)
          .where(eq(tickets.departmentId, id))) as [{ count: number }];
        if (count > 0) {
          if (!moveTasksTo) return "department_has_tasks" as const;
          const [target] =
            moveTasksTo === id
              ? []
              : await tx.select({ id: departments.id }).from(departments).where(eq(departments.id, moveTasksTo));
          if (!target) return "department_move_target_invalid" as const;
          // In SQL: il trasloco non è lavoro sulla task, `updated_at` resta.
          // Il cambio di reparto non entra nel feed (scelta della fetta 1).
          await tx.execute(sql`update "tickets" set "department_id" = ${moveTasksTo} where "department_id" = ${id}`);
        }
        await tx.delete(departments).where(eq(departments.id, id));
        return null;
      });
      if (outcome === "department_has_tasks") {
        return apiError(reply, 400, "department_has_tasks", "Move the department's tasks first");
      }
      if (outcome === "department_move_target_invalid") {
        return apiError(reply, 400, "department_move_target_invalid", "Choose another existing department");
      }
      return reply.code(204).send(null);
    },
  );
}
