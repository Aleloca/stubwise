import { backlogItemRequesters, backlogItems, projects } from "@stubwise/db";
import { requestToConvertViewSchema, type RequestToConvertView } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { inProjects, projectIdsWithPermission } from "../auth/access.js";
import { backlogVisibleSql } from "../services/backlog-visibility.js";
import { authErrorResponses } from "./shared.js";

/**
 * Le richieste da trasformare (integrazione area 2, fetta 3), per «Da
 * decidere» e il blocco «Richieste nuove»: voci di backlog nuove, in
 * rifinitura o pronte, non fuse, dei progetti dove chi guarda può creare
 * task (`tickets.create`, che implica vederli) e col backlog acceso, dalla
 * più recente. La regola
 * di `backlog.view_all` è quella dell'elenco del backlog: senza, solo le
 * voci di cui si è richiedenti. Tutto nella WHERE.
 */

const LIMIT = 200;

export async function requestRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/requests/to-convert",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: z.array(requestToConvertViewSchema), ...authErrorResponses } },
    },
    async (request): Promise<RequestToConvertView[]> => {
      const viewer = request.user!;
      const canCreate = await projectIdsWithPermission(app.db, viewer, "tickets.create");
      if (canCreate !== "all" && canCreate.length === 0) return [];
      const conditions: SQL[] = [
        inArray(backlogItems.status, ["new", "refining", "ready"]),
        isNull(backlogItems.mergedIntoId),
        // Solo i progetti col backlog acceso (fix della review della fetta 3).
        eq(projects.backlogEnabled, true),
      ];
      const inCreatable = inProjects(backlogItems.projectId, canCreate);
      if (inCreatable) conditions.push(inCreatable);
      const visible = backlogVisibleSql(
        await projectIdsWithPermission(app.db, viewer, "backlog.view_all"),
        viewer.id,
      );
      if (visible) conditions.push(visible);
      // Il numero di catalogo: la posizione della voce fra TUTTE quelle del
      // progetto (fuse e archiviate comprese), per data di creazione.
      const ordinal = sql<number>`(
        select count(*)::int from ${backlogItems} b2
        where b2.project_id = ${backlogItems.projectId}
          and (b2.created_at, b2.id) <= (${backlogItems.createdAt}, ${backlogItems.id})
      )`;
      const rows = await app.db
        .select({
          id: backlogItems.id,
          projectId: backlogItems.projectId,
          projectCode: projects.code,
          title: backlogItems.title,
          status: backlogItems.status,
          urgency: backlogItems.urgency,
          requestCount: backlogItems.requestCount,
          createdAt: backlogItems.createdAt,
          ordinal,
        })
        .from(backlogItems)
        .innerJoin(projects, sql`${projects.id} = ${backlogItems.projectId}`)
        .where(and(...conditions))
        .orderBy(desc(backlogItems.createdAt), desc(backlogItems.id))
        .limit(LIMIT);
      if (rows.length === 0) return [];
      const requesters = await app.db
        .select({ itemId: backlogItemRequesters.itemId, userId: backlogItemRequesters.userId })
        .from(backlogItemRequesters)
        .where(inArray(backlogItemRequesters.itemId, rows.map((r) => r.id)))
        .orderBy(asc(backlogItemRequesters.requestedAt), asc(backlogItemRequesters.userId));
      const requestersOf = new Map<string, string[]>();
      for (const r of requesters) requestersOf.set(r.itemId, [...(requestersOf.get(r.itemId) ?? []), r.userId]);
      return rows.map((r) => ({
        id: r.id,
        code: `${r.projectCode}-R${r.ordinal}`,
        projectId: r.projectId,
        title: r.title,
        status: r.status,
        urgency: r.urgency,
        requesterIds: requestersOf.get(r.id) ?? [],
        requestCount: r.requestCount,
        createdAt: r.createdAt.toISOString(),
        webHref: `/backlog/${r.id}`,
      }));
    },
  );
}
