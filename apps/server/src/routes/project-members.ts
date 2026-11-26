import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { projectMemberSchema, putProjectMemberSchema } from "@stubwise/shared";
import { users } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { routePermissions } from "../auth/access.js";
import { apiError } from "../errors.js";
import { fromParam } from "../auth/project-resolvers.js";
import {
  listProjectMembers,
  putProjectMember,
  removeProjectMember,
  type MemberRow,
} from "../services/roles.js";
import { roleRuleErrorSchema, sendRoleRuleError } from "./roles.js";
import { memberDraftSchema, memberPreviewSchema, projectMembersViewSchema } from "@stubwise/shared";
import { previewMember, projectMembersView } from "../services/admin-roles.js";
import { authErrorResponses, errorSchema } from "./shared.js";

function toMemberView(row: MemberRow): z.infer<typeof projectMemberSchema> {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    permissions: row.permissions.map((p) => ({
      permission: p.permission,
      sources: p.sources.map((src) =>
        src.kind === "role"
          ? { kind: "role" as const, roleId: src.roleId, byUserId: null, at: null, departmentId: null }
          : src.kind === "department"
            ? { kind: "department" as const, roleId: null, byUserId: null, at: null, departmentId: src.departmentId }
            : { kind: "grant" as const, roleId: null, byUserId: src.byUserId, at: src.at, departmentId: null },
      ),
    })),
  };
}

const projectParamsSchema = z.object({ projectId: z.uuid() });
const memberParamsSchema = projectParamsSchema.extend({ userId: z.uuid() });

/**
 * Membri di un progetto, sotto /api/projects/:projectId/members. L'elenco lo
 * vede ogni membro; aggiungere, cambiare ruolo e togliere richiede
 * `project.members.manage` nel progetto, e un ruolo si assegna solo se i suoi
 * permessi sono inclusi in quelli di chi agisce lì (anti-escalation, in
 * `services/roles.ts`). I full admin sono membri impliciti e non compaiono.
 */
export async function projectMemberRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Area 9, F1 (R8): la vista di gestione coi campi calcolati, e il giudizio
  // di una bozza del pannello del membro. Letterali PRIMA delle parametriche.
  app.get(
    "/:projectId/members/view",
    {
      config: { mcp: { action: "projects.membersView", summary: "La vista dei membri di un progetto come l'amministrazione: chi c'è, cosa si può dare, chi si può aggiungere.", effect: "read", note: "Aggiungere, togliere o cambiare il ruolo di un membro chiede la riconferma: si fa dall'app." }, access: { kind: "project", permission: "member", project: fromParam("projectId") } },
      schema: { params: projectParamsSchema, response: { 200: projectMembersViewSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request) => projectMembersView(app.db, request.user!, request.params.projectId),
  );

  app.post(
    "/:projectId/members/:userId/preview",
    {
      config: { mcp: { action: "projects.memberPreview", summary: "Anteprima: cosa guadagnerebbe o perderebbe una persona con un ruolo e dei permessi. Non scrive niente.", effect: "write" }, access: { kind: "project", permission: "project.members.manage", project: fromParam("projectId") } },
      schema: {
        params: z.object({ projectId: z.uuid(), userId: z.uuid() }),
        body: memberDraftSchema,
        response: { 200: memberPreviewSchema, 404: errorSchema, 422: roleRuleErrorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      try {
        return await previewMember(app.db, request.user!, request.params.projectId, request.params.userId, request.body);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  app.get(
    "/:projectId/members",
    {
      config: { mcp: { action: "projects.members", summary: "I membri di un progetto, coi ruoli e i permessi.", effect: "read" },
        access: { kind: "project", permission: "member", project: fromParam("projectId") },
      },
      schema: {
        params: projectParamsSchema,
        response: { 200: z.array(projectMemberSchema), 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request) =>
      (await listProjectMembers(app.db, request.params.projectId)).map(toMemberView),
  );

  app.put(
    "/:projectId/members/:userId",
    {
      config: {
        access: {
          kind: "project",
          permission: "project.members.manage",
          project: fromParam("projectId"),
        },
        reauth: true,
      },
      schema: {
        params: memberParamsSchema,
        body: putProjectMemberSchema,
        response: {
          200: projectMemberSchema,
          ...authErrorResponses,
          400: roleRuleErrorSchema,
          403: roleRuleErrorSchema,
          404: roleRuleErrorSchema,
          // Area 9, F1: l'ultimo gestore (409) e un permesso fuori catalogo (422).
          409: roleRuleErrorSchema,
          422: roleRuleErrorSchema,
        },
      },
    },
    async (request, reply) => {
      // L'utente di sistema «Claude» (fetta 3e) non è un membro: lavora sulle
      // task che gli si assegnano, senza ruolo nel progetto.
      const [target] = await app.db.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, request.params.userId));
      if (target?.isAgent) return apiError(reply, 404, "user_not_found", "User not found");
      try {
        const member = await putProjectMember(
          app.db,
          request.user!,
          routePermissions(request),
          request.params.projectId,
          request.params.userId,
          request.body.roleId,
          request.body.permissions,
        );
        return reply.code(200).send(toMemberView(member));
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  app.delete(
    "/:projectId/members/:userId",
    {
      config: {
        access: {
          kind: "project",
          permission: "project.members.manage",
          project: fromParam("projectId"),
        },
        reauth: true,
      },
      schema: {
        params: memberParamsSchema,
        response: {
          204: z.null(),
          ...authErrorResponses,
          403: roleRuleErrorSchema,
          404: roleRuleErrorSchema,
          409: roleRuleErrorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await removeProjectMember(
          app.db,
          request.user!,
          routePermissions(request),
          request.params.projectId,
          request.params.userId,
        );
        return reply.code(204).send(null);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );
}
