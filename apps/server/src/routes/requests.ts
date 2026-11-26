import { registerPersonMask } from "../services/people-known.js";
import { backlogItemRequesters, backlogItems, projects, type Db } from "@stubwise/db";
import type { SessionUser } from "../auth/session.js";
import { requestToConvertViewSchema, type RequestToConvertView } from "@stubwise/shared";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { inProjects, projectIdsWithPermission, isAllProjects } from "../auth/access.js";
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

/** Registro, A11 r.1414: le chiavi delle risposte che portano una persona. */
const REQUEST_PERSON_KEYS: ReadonlySet<string> = new Set(["requesterIds"]);

/**
 * La regola delle richieste da trasformare (vedi sopra), in UN posto: la usano
 * questa rotta e il polso aggregato (`GET /api/projects/pulses`, lotto 7, voce
 * 4). `null` = chi guarda non può crearne in nessun progetto. La tabella
 * `projects` va nel join di chi la usa (`backlogEnabled`).
 */
export async function requestsToConvertConditions(db: Db, viewer: SessionUser): Promise<SQL[] | null> {
  const canCreate = await projectIdsWithPermission(db, viewer, "tickets.create");
  if (!isAllProjects(canCreate) && canCreate.length === 0) return null;
  const conditions: SQL[] = [
    inArray(backlogItems.status, ["new", "refining", "ready"]),
    isNull(backlogItems.mergedIntoId),
    // Solo i progetti col backlog acceso (fix della review della fetta 3).
    eq(projects.backlogEnabled, true),
  ];
  const inCreatable = inProjects(backlogItems.projectId, canCreate);
  if (inCreatable) conditions.push(inCreatable);
  const visible = backlogVisibleSql(await projectIdsWithPermission(db, viewer, "backlog.view_all"), viewer.id);
  if (visible) conditions.push(visible);
  return conditions;
}

export async function requestRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  // Registro, A11 r.1414: chi guarda non riceve l'id di chi non conosce.
  registerPersonMask(app, REQUEST_PERSON_KEYS);

  app.get(
    "/requests/to-convert",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: z.array(requestToConvertViewSchema), ...authErrorResponses } },
    },
    async (request): Promise<RequestToConvertView[]> => {
      const viewer = request.user!;
      const conditions = await requestsToConvertConditions(app.db, viewer);
      if (!conditions) return [];
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
          number: backlogItems.number,
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
        code: `${r.projectCode}-R${r.number}`,
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
