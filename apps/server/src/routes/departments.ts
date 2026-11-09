import { departmentMembers, departmentRoles, departments, tickets, users } from "@stubwise/db";
import {
  DEPARTMENT_PERMISSIONS,
  departmentColorTokenSchema,
  departmentRoleViewSchema,
  departmentViewSchema,
  type DepartmentView,
} from "@stubwise/shared";
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

  async function rolesOf(db: Pick<typeof app.db, "select">, departmentId?: string) {
    return db
      .select({
        departmentId: departmentRoles.departmentId,
        userId: departmentRoles.userId,
        permissions: departmentRoles.permissions,
      })
      .from(departmentRoles)
      .where(departmentId ? eq(departmentRoles.departmentId, departmentId) : undefined)
      .orderBy(asc(departmentRoles.departmentId), asc(departmentRoles.userId));
  }

  /**
   * I ruoli di reparto di tutti (fetta 3): chi gestisce la Home di quale
   * reparto. Li legge ogni persona, come l'elenco dei reparti: non danno
   * accesso a dati. Rotta LETTERALE: registrata prima delle `/:id`.
   */
  app.get(
    "/roles",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: z.array(departmentRoleViewSchema), ...authErrorResponses } },
    },
    async () => rolesOf(app.db),
  );

  /**
   * SOSTITUISCE i ruoli di un reparto (fetta 3): `departments.manage`, che è
   * il permesso dei reparti Home compresa — quindi nessun confronto
   * d'escalation su `department.home.manage` e nessuna riconferma (decisione
   * del maintainer, 9 nov 2026). Una persona senza permessi esce dall'elenco.
   */
  app.put(
    "/:id/roles",
    {
      config: { access: MANAGE },
      schema: {
        params: idParamsSchema,
        body: z.object({
          roles: z
            .array(
              z.object({
                userId: z.uuid(),
                permissions: z.array(z.enum(DEPARTMENT_PERMISSIONS)).max(DEPARTMENT_PERMISSIONS.length),
              }),
            )
            .max(2000),
        }),
        response: { 200: z.array(departmentRoleViewSchema), 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const wanted = new Map<string, string[]>();
      for (const r of request.body.roles) {
        const perms = [...new Set([...(wanted.get(r.userId) ?? []), ...r.permissions])];
        wanted.set(r.userId, perms);
      }
      const ids = [...wanted.keys()];
      // Tutto sotto il lock del reparto (fix della review della fetta 3): due
      // PUT concorrenti si serializzano, e `before` è quello davvero sostituito.
      const outcome = await app.db.transaction(async (tx) => {
        const [dept] = await tx
          .select({ id: departments.id })
          .from(departments)
          .where(eq(departments.id, id))
          .for("update");
        if (!dept) return "not_found" as const;
        // Un ruolo di reparto vale solo per chi è nel reparto.
        if (ids.length) {
          const members = await tx
            .select({ id: departmentMembers.userId })
            .from(departmentMembers)
            .where(and(eq(departmentMembers.departmentId, id), inArray(departmentMembers.userId, ids)));
          if (members.length !== ids.length) return "invalid_person" as const;
        }
        const before = await rolesOf(tx, id);
        await tx.delete(departmentRoles).where(eq(departmentRoles.departmentId, id));
        const rows = [...wanted].filter(([, p]) => p.length > 0);
        if (rows.length) {
          await tx
            .insert(departmentRoles)
            .values(rows.map(([userId, permissions]) => ({ departmentId: id, userId, permissions })));
        }
        return { before, after: await rolesOf(tx, id) };
      });
      if (outcome === "not_found") return apiError(reply, 404, "not_found", "Department not found");
      if (outcome === "invalid_person") {
        return apiError(reply, 400, "invalid_person", "A department role is only for people in the department");
      }
      // Il registro delle modifiche d'istanza non c'è ancora sul server (area 9): una riga di log.
      const people = (rows: { userId: string; permissions: string[] }[]) =>
        rows.map((r) => ({ userId: r.userId, permissions: r.permissions }));
      request.log.info(
        {
          event: "department.home_managers_changed",
          actorId: request.user!.id,
          departmentId: id,
          before: people(outcome.before),
          after: people(outcome.after),
        },
        "department roles changed",
      );
      return outcome.after;
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
          // Chi esce dal reparto perde anche i suoi ruoli lì (fix fetta 3).
          await tx
            .delete(departmentRoles)
            .where(
              next.length > 0
                ? and(eq(departmentRoles.departmentId, id), notInArray(departmentRoles.userId, next))
                : eq(departmentRoles.departmentId, id),
            );
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
