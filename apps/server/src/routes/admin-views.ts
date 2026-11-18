import { adminRoleViewSchema, inviteChoicesSchema, inviteViewSchema, personDetailSchema, personRowSchema } from "@stubwise/shared";
import { invites } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { adminRoleViews, inviteChoices, inviteTokenOf, inviteViews } from "../services/admin-roles.js";
import { browserOrConfirmedDesktop, projectIdsWithPermission } from "../auth/access.js";
import { apiError } from "../errors.js";
import { recordChange } from "../services/change-log.js";
import { inviteObject } from "../services/invite-change.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { listPeopleRows, personDetail } from "../services/admin-people.js";
import { sendRoleRuleError } from "./roles.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * Area 9, F1 (aggiunta per R7 e R8 del renderer): le letture CALCOLATE
 * dell'amministrazione, sotto `/api/admin`. Tutte `user`: filtrano su chi
 * guarda, e i campi «si può / manca» vengono dalle funzioni delle scritture.
 */
export async function adminViewRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/people",
    { config: { access: { kind: "user" } }, schema: { response: { 200: z.array(personRowSchema), ...authErrorResponses } } },
    async (request) => listPeopleRows(app.db, request.user!),
  );

  app.get(
    "/people/:id",
    {
      config: { access: { kind: "user" } },
      schema: { params: z.object({ id: z.uuid() }), response: { 200: personDetailSchema, ...authErrorResponses, 404: errorSchema } },
    },
    async (request, reply) => {
      try {
        return await personDetail(app.db, request.user!, request.params.id, { browserOk: browserOrConfirmedDesktop(request.user!).ok });
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  // I ruoli: chi può leggere il catalogo (`GET /api/roles`) legge anche questa vista.
  app.get(
    "/roles",
    { config: { access: { kind: "user" } }, schema: { response: { 200: z.array(adminRoleViewSchema), ...authErrorResponses } } },
    async (request, reply) => {
      const user = request.user!;
      const perms = user.instancePermissions;
      if (!perms.has("roles.manage") && !perms.has("users.manage") && !perms.has("users.invite")) {
        const managed = await projectIdsWithPermission(app.db, user, "project.members.manage");
        if (managed !== "all" && managed.length === 0) return apiError(reply, 403, "forbidden", "Missing permission");
      }
      return adminRoleViews(app.db, user);
    },
  );

  app.get(
    "/invites",
    { config: { access: { kind: "instance", permission: "users.invite" } }, schema: { response: { 200: z.array(inviteViewSchema), ...authErrorResponses } } },
    async (request) => inviteViews(app.db, request.user!),
  );

  // La revoca con l'id OPACO: il token non esce dalle viste nuove.
  app.delete(
    "/invites/:id",
    {
      config: { access: { kind: "instance", permission: "users.invite" } },
      schema: { params: z.object({ id: z.string().regex(/^i_[0-9a-f]{32}$/) }), response: { 204: z.null(), 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const token = await inviteTokenOf(app.db, request.params.id);
      if (!token) return apiError(reply, 404, "invite_not_found", "Invite not found");
      const deleted = await app.db.transaction(async (tx) => {
        const [row] = await tx.delete(invites).where(eq(invites.token, token)).returning({ token: invites.token, email: invites.email });
        if (row) await recordChange(tx, { type: "invite.revoked", actor: request.user!, projectId: null, data: { object: inviteObject(row.token, row.email) } });
        return row;
      });
      if (!deleted) return apiError(reply, 404, "invite_not_found", "Invite not found");
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/invite-choices",
    { config: { access: { kind: "instance", permission: "users.invite" } }, schema: { response: { 200: inviteChoicesSchema, ...authErrorResponses } } },
    async (request) => inviteChoices(app.db, request.user!),
  );
}
