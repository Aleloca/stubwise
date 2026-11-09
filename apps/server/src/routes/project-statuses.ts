import { projectStatuses, projects, ticketEvents, tickets, type Db } from "@stubwise/db";
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

      const legacy = legacyStatusesFor(statuses.map((s) => s.family));
      // Tutto nella transazione, con gli stati del progetto bloccati (`FOR
      // UPDATE`): il conteggio delle task da spostare e lo spostamento vedono
      // la stessa fotografia, e due salvataggi concorrenti si mettono in fila
      // invece di finire in un 500.
      const outcome = await app.db.transaction(async (tx) => {
        const current = (await tx.execute(sql`
          select "id", "family", "legacy_status" from "project_statuses"
          where "project_id" = ${projectId} order by "position" for update
        `)) as unknown as { id: string; family: string; legacy_status: string }[];
        const currentById = new Map(current.map((c) => [c.id, c]));
        const keptIds = statuses.flatMap((st) => (st.id ? [st.id] : []));
        if (new Set(keptIds).size !== keptIds.length || keptIds.some((id) => !currentById.has(id))) {
          return { error: "status_not_found" as const };
        }
        const kept = new Set(keptIds);
        const removed = current.filter((c) => !kept.has(c.id)).map((c) => c.id);

        // Uno stato eliminato con delle task vuole dove spostarle, verso uno
        // stato che resta.
        const moving =
          removed.length > 0
            ? await tx
                .select({ id: tickets.id, statusId: tickets.statusId, status: tickets.status })
                .from(tickets)
                .where(inArray(tickets.statusId, removed))
                .for("update")
            : [];
        for (const statusId of new Set(moving.map((m) => m.statusId))) {
          const target = reassign[statusId];
          if (!target) return { error: "status_reassign_missing" as const };
          if (!kept.has(target)) return { error: "status_reassign_invalid" as const };
        }

        // Prima gli stati (così un trasloco verso uno stato che cambia
        // famiglia legge già quella nuova), poi le task, poi gli eliminati.
        for (const [position, st] of statuses.entries()) {
          if (st.id) {
            await tx
              .update(projectStatuses)
              .set({ name: st.name, family: st.family, position, legacyStatus: legacy[position]! })
              .where(and(eq(projectStatuses.id, st.id), eq(projectStatuses.projectId, projectId)));
          } else {
            await tx
              .insert(projectStatuses)
              .values({ projectId, name: st.name, family: st.family, position, legacyStatus: legacy[position]! });
          }
        }

        // Il trasloco è un fatto di SISTEMA: in SQL (niente `$onUpdate` di
        // Drizzle, quindi `updated_at` resta quello del lavoro vero) e con lo
        // `status_changed` di oggi, senza attore.
        for (const statusId of new Set(moving.map((m) => m.statusId))) {
          const target = reassign[statusId]!;
          const moved = (await tx.execute(sql`
            update "tickets" set "status_id" = ${target}
            where "status_id" = ${statusId}
            returning "id", "status"
          `)) as unknown as { id: string; status: string }[];
          const before = new Map(moving.filter((m) => m.statusId === statusId).map((m) => [m.id, m.status]));
          if (moved.length > 0) {
            await tx.insert(ticketEvents).values(
              moved.map((m) => ({
                ticketId: m.id,
                actorId: null,
                kind: "status_changed" as const,
                payload: { from: before.get(m.id) ?? m.status, to: m.status, fromStatusId: statusId, toStatusId: target },
              })),
            );
          }
        }
        if (removed.length > 0) await tx.delete(projectStatuses).where(inArray(projectStatuses.id, removed));

        // Riallineare l'enum SOLO per gli stati la cui famiglia o il cui
        // `legacy_status` sono cambiati davvero: una rinomina non tocca le
        // task. Un `triaged` dentro un todo resta `triaged`.
        const changed = statuses.flatMap((st, position) => {
          const before = st.id ? currentById.get(st.id) : undefined;
          return before && (before.family !== st.family || before.legacy_status !== legacy[position]) ? [st.id!] : [];
        });
        if (changed.length > 0) {
          await tx.execute(sql`
            update "tickets" t
            set "status" = s."legacy_status",
                "closed_at" = case when s."family" = 'closed' then coalesce(t."closed_at", now()) else null end
            from "project_statuses" s
            where t."status_id" = s."id" and ${inArray(sql`s."id"`, changed)}
              and (stubwise_legacy_family(t."status") <> s."family"
                or (s."family" <> 'todo' and t."status" <> s."legacy_status"))
          `);
        }
        return { error: null };
      });
      if (outcome.error === "status_not_found") {
        return apiError(reply, 400, "status_not_found", "A status does not belong to this project");
      }
      if (outcome.error === "status_reassign_missing") {
        return apiError(reply, 400, "status_reassign_missing", "Choose where the status's tasks go");
      }
      if (outcome.error === "status_reassign_invalid") {
        return apiError(reply, 400, "status_reassign_invalid", "Tasks can move only to a status that stays");
      }
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
