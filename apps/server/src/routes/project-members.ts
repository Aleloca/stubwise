import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { projectMemberSchema, putProjectMemberSchema } from "@stubwise/shared";
import { routePermissions } from "../auth/access.js";
import { fromParam } from "../auth/project-resolvers.js";
import {
  listProjectMembers,
  putProjectMember,
  removeProjectMember,
  type MemberRow,
} from "../services/roles.js";
import { roleRuleErrorSchema, sendRoleRuleError } from "./roles.js";
import { authErrorResponses, errorSchema } from "./shared.js";

function toMemberView(row: MemberRow): z.infer<typeof projectMemberSchema> {
  return { ...row, createdAt: row.createdAt.toISOString() };
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

  app.get(
    "/:projectId/members",
    {
      config: {
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
        },
      },
    },
    async (request, reply) => {
      try {
        const member = await putProjectMember(
          app.db,
          request.user!,
          routePermissions(request),
          request.params.projectId,
          request.params.userId,
          request.body.roleId,
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
