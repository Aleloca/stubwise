import { departmentMembers, projectMembers, users } from "@stubwise/db";
import { personViewSchema, type PersonView } from "@stubwise/shared";
import { asc, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { visibleProjectIds } from "../auth/access.js";
import { initialsOf, personName } from "../services/people.js";
import { authErrorResponses } from "./shared.js";

/**
 * Persone (integrazione area 2, fetta 1): chi condivide almeno un progetto
 * visibile con chi guarda, più sé stesso; un full admin le vede tutte. Il
 * filtro è nella WHERE (`docs/invariants/permissions.md`): un non membro non
 * scopre chi lavora in un progetto che non vede.
 */
export async function peopleRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: z.array(personViewSchema), ...authErrorResponses } },
    },
    async (request): Promise<PersonView[]> => {
      const viewer = request.user!;
      const visible = await visibleProjectIds(app.db, viewer);
      let ids: string[] | "all" = "all";
      if (visible !== "all") {
        const rows =
          visible.length > 0
            ? await app.db
                .selectDistinct({ userId: projectMembers.userId })
                .from(projectMembers)
                .where(inArray(projectMembers.projectId, visible))
            : [];
        ids = [...new Set([viewer.id, ...rows.map((r) => r.userId)])];
      }
      const people = await app.db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(ids === "all" ? undefined : inArray(users.id, ids))
        .orderBy(asc(users.email));
      if (people.length === 0) return [];
      const memberships = await app.db
        .select({ userId: departmentMembers.userId, departmentId: departmentMembers.departmentId })
        .from(departmentMembers)
        .where(inArray(departmentMembers.userId, people.map((p) => p.id)))
        .orderBy(asc(departmentMembers.position), asc(departmentMembers.departmentId));
      const deptsOf = new Map<string, string[]>();
      for (const m of memberships) deptsOf.set(m.userId, [...(deptsOf.get(m.userId) ?? []), m.departmentId]);
      return people.map((p) => {
        const name = personName(p);
        return {
          id: p.id,
          name,
          initials: initialsOf(name),
          departmentIds: deptsOf.get(p.id) ?? [],
          email: p.email,
          deactivated: false,
        };
      });
    },
  );
}
