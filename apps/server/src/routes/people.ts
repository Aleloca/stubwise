import { departmentMembers, users } from "@stubwise/db";
import { peopleActivityQuerySchema, personDayActivitySchema, personViewSchema, type PersonView } from "@stubwise/shared";
import { asc, eq, inArray, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { projectIdsWithPermission, scopeProjectIds } from "../auth/access.js";
import { initialsOf, personName } from "../services/people.js";
import { peopleActivity } from "../services/people-activity.js";
import { avatarUrlsFor } from "../services/avatars.js";
import { visiblePersonIds } from "../services/people-visibility.js";
import { authErrorResponses } from "./shared.js";

/**
 * Persone (integrazione area 2, fetta 1): chi condivide almeno un progetto
 * visibile con chi guarda (i full admin compresi, membri impliciti di ogni
 * progetto), più sé stesso; un full admin le vede tutte. Il
 * filtro è nella WHERE (`docs/invariants/permissions.md`): un non membro non
 * scopre chi lavora in un progetto che non vede.
 */
export async function peopleRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /**
   * L'attività del giorno per persona (integrazione area 3, fetta 3d: lo
   * standup), solo con `people.activity.view` (nessun preset lo riceve tranne
   * il full admin). Il giorno è nel fuso Europe/Rome; solo i fatti dei progetti
   * che chi guarda vede (`services/people-activity.ts`).
   */
  app.get(
    "/activity",
    {
      config: { access: { kind: "instance", permission: "people.activity.view" } , mcp: { action: "people.activity", summary: "L'attività del giorno per persona (serve `people.activity.view`).", effect: "read" }},
      schema: {
        querystring: peopleActivityQuerySchema,
        response: { 200: z.array(personDayActivitySchema), ...authErrorResponses },
      },
    },
    async (request) => peopleActivity(app.db, request.user!, request.query.date, request.query.departmentId),
  );

  app.get(
    "/",
    {
      config: { access: { kind: "user" } , mcp: { action: "people.list", summary: "Le persone che vedi (nome ed email), compreso l'utente di sistema «Claude» a cui si assegnano task.", effect: "read" }},
      schema: { response: { 200: z.array(personViewSchema), ...authErrorResponses } },
    },
    async (request): Promise<PersonView[]> => {
      const viewer = request.user!;
      // La regola di chi si vede sta in UN posto (la usa anche la foto, area 9).
      const ids = await visiblePersonIds(app.db, viewer);
      // L'utente di sistema «Claude» (area 3, fetta 3e) c'è SEMPRE: chi legge una
      // task assegnata a lui ne vede il nome. Dove chi guarda può assegnarlo lo
      // dice `claudeAssignableProjectIds` (i progetti visibili con `runs.start`).
      const people = await app.db
        .select({ id: users.id, email: users.email, displayName: users.displayName, isAgent: users.isAgent, deactivatedAt: users.deactivatedAt })
        .from(users)
        .where(ids === "all" ? undefined : or(inArray(users.id, ids), eq(users.isAgent, true)))
        .orderBy(asc(users.email));
      if (people.length === 0) return [];
      const memberships = await app.db
        .select({ userId: departmentMembers.userId, departmentId: departmentMembers.departmentId })
        .from(departmentMembers)
        .where(inArray(departmentMembers.userId, people.map((p) => p.id)))
        .orderBy(asc(departmentMembers.position), asc(departmentMembers.departmentId));
      const deptsOf = new Map<string, string[]>();
      for (const m of memberships) deptsOf.set(m.userId, [...(deptsOf.get(m.userId) ?? []), m.departmentId]);
      const canRun = people.some((p) => p.isAgent) ? await projectIdsWithPermission(app.db, viewer, "runs.start") : [];
      const assignable = await scopeProjectIds(app.db, canRun, { orderByName: true });
      const avatars = await avatarUrlsFor(app.db, people.map((p) => p.id));
      return people.map((p) => {
        const name = personName(p);
        return {
          id: p.id,
          name,
          initials: initialsOf(name),
          departmentIds: deptsOf.get(p.id) ?? [],
          email: p.email,
          // Area 9, F1 (D-6): il campo c'era già, ora dice il vero.
          deactivated: p.deactivatedAt !== null,
          isClaude: p.isAgent,
          claudeAssignableProjectIds: p.isAgent ? assignable : [],
          avatarUrl: avatars.get(p.id) ?? null,
        };
      });
    },
  );
}
