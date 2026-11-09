import { projectStatuses, projects, tickets, type Db } from "@stubwise/db";
import { projectStatusViewSchema, statusFamilySchema, type ProjectStatusView, type StatusFamily } from "@stubwise/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ProjectPermission } from "@stubwise/shared";
import type { RouteAccess } from "../auth/access.js";
import { fromParam } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Stati e soglie «ferma» del progetto (integrazione area 2, fetta 1):
 * Impostazioni del progetto → Stati, come nel prototipo. Lo stato vero di una
 * task è `tickets.status_id`; l'enum `tickets.status` lo deriva il trigger
 * `tickets_status_sync` (`docs/invariants/tasks.md`), e qui si calcola solo il
 * `legacy_status` di ogni stato, con la regola del Task 2.
 */

const onProject = (permission: ProjectPermission | "member"): RouteAccess => ({
  kind: "project",
  permission,
  project: fromParam("projectId"),
});

const paramsSchema = z.object({ projectId: z.uuid() });

const putBodySchema = z.object({
  statuses: z
    .array(
      z.object({
        id: z.uuid().optional(),
        name: z.string().trim().min(1).max(60),
        family: statusFamilySchema,
      }),
    )
    .min(1)
    .max(30),
  /** Stato eliminato → stato (rimasto) dove vanno le sue task. */
  reassign: z.record(z.uuid(), z.uuid()).default({}),
});

type LegacyStatus = "open" | "in_progress" | "in_review" | "done" | "closed";

/**
 * «todo → open; active: il primo → in_progress, gli altri → in_review;
 * closed: il primo → done, gli altri → closed».
 */
export function legacyStatusesFor(families: readonly StatusFamily[]): LegacyStatus[] {
  const seen = { todo: 0, active: 0, closed: 0 };
  return families.map((family) => {
    const nth = seen[family]++;
    if (family === "todo") return "open";
    if (family === "active") return nth === 0 ? "in_progress" : "in_review";
    return nth === 0 ? "done" : "closed";
  });
}

async function listStatuses(db: Pick<Db, "select">, projectId: string): Promise<ProjectStatusView[]> {
  const rows = await db
    .select({
      id: projectStatuses.id,
      projectId: projectStatuses.projectId,
      name: projectStatuses.name,
      family: projectStatuses.family,
      position: projectStatuses.position,
    })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(asc(projectStatuses.position));
  return rows;
}

export async function projectStatusRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/:projectId/statuses",
    {
      config: { access: onProject("member") },
      schema: {
        params: paramsSchema,
        response: { 200: z.array(projectStatusViewSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request) => listStatuses(app.db, request.params.projectId),
  );

  app.put(
    "/:projectId/statuses",
    {
      config: { access: onProject("project.settings.manage") },
      schema: {
        params: paramsSchema,
        body: putBodySchema,
        response: {
          200: z.array(projectStatusViewSchema),
          400: errorSchema,
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const { statuses, reassign } = request.body;

      // Almeno uno stato per famiglia: senza un `closed` una task non si
      // chiuderebbe, senza un `todo` non nascerebbe.
      for (const family of statusFamilySchema.options) {
        if (!statuses.some((s) => s.family === family)) {
          return apiError(reply, 400, "status_family_missing", `At least one ${family} status is required`);
        }
      }

      const current = await listStatuses(app.db, projectId);
      const currentIds = new Set(current.map((s) => s.id));
      const keptIds = statuses.flatMap((s) => (s.id ? [s.id] : []));
      if (new Set(keptIds).size !== keptIds.length || keptIds.some((id) => !currentIds.has(id))) {
        return apiError(reply, 400, "status_not_found", "A status does not belong to this project");
      }
      const kept = new Set(keptIds);
      const removed = current.filter((s) => !kept.has(s.id)).map((s) => s.id);

      // Uno stato eliminato con delle task vuole dove spostarle, verso uno
      // stato che resta.
      const counts =
        removed.length > 0
          ? await app.db
              .select({ statusId: tickets.statusId, count: sql<number>`count(*)::int` })
              .from(tickets)
              .where(inArray(tickets.statusId, removed))
              .groupBy(tickets.statusId)
          : [];
      for (const { statusId, count } of counts) {
        if (count === 0) continue;
        const target = reassign[statusId];
        if (!target) {
          return apiError(reply, 400, "status_reassign_missing", "Choose where the status's tasks go");
        }
        if (!kept.has(target)) {
          return apiError(reply, 400, "status_reassign_invalid", "Tasks can move only to a status that stays");
        }
      }

      const legacy = legacyStatusesFor(statuses.map((s) => s.family));
      await app.db.transaction(async (tx) => {
        for (const { statusId } of counts) {
          await tx.update(tickets).set({ statusId: reassign[statusId]! }).where(eq(tickets.statusId, statusId));
        }
        if (removed.length > 0) await tx.delete(projectStatuses).where(inArray(projectStatuses.id, removed));
        // Posizioni riscritte in blocco: l'unicità (progetto, posizione) è
        // differita a fine transazione.
        for (const [position, s] of statuses.entries()) {
          if (s.id) {
            await tx
              .update(projectStatuses)
              .set({ name: s.name, family: s.family, position, legacyStatus: legacy[position]! })
              .where(and(eq(projectStatuses.id, s.id), eq(projectStatuses.projectId, projectId)));
          } else {
            await tx
              .insert(projectStatuses)
              .values({ projectId, name: s.name, family: s.family, position, legacyStatus: legacy[position]! });
          }
        }
        // Le task degli stati che hanno cambiato `legacy_status` o famiglia
        // riallineano l'enum (il trigger fa il resto). Un `triaged` dentro un
        // todo resta `triaged`: per un todo conta solo la famiglia.
        await tx.execute(sql`
          update "tickets" t
          set "status" = s."legacy_status",
              "closed_at" = case when s."family" = 'closed' then coalesce(t."closed_at", now()) else null end
          from "project_statuses" s
          where t."status_id" = s."id" and s."project_id" = ${projectId}
            and (stubwise_legacy_family(t."status") <> s."family"
              or (s."family" <> 'todo' and t."status" <> s."legacy_status"))
        `);
      });
      return listStatuses(app.db, projectId);
    },
  );

  app.put(
    "/:projectId/stall-thresholds",
    {
      config: { access: onProject("project.settings.manage") },
      schema: {
        params: paramsSchema,
        body: z.object({
          activeDays: z.number().int().min(1).max(90),
          todoDays: z.number().int().min(1).max(90),
        }),
        response: {
          200: z.object({ activeDays: z.number().int(), todoDays: z.number().int() }),
          404: errorSchema,
          ...authErrorResponses,
        },
      },
    },
    async (request) => {
      const { activeDays, todoDays } = request.body;
      const [row] = await app.db
        .update(projects)
        .set({ stallActiveDays: activeDays, stallTodoDays: todoDays })
        .where(eq(projects.id, request.params.projectId))
        .returning({ activeDays: projects.stallActiveDays, todoDays: projects.stallTodoDays });
      return row!;
    },
  );
}
