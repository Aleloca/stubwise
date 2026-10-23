import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createRoleSchema,
  duplicateRoleSchema,
  roleSchema,
  roleScopeSchema,
  updateRoleSchema,
} from "@stubwise/shared";
import { projectIdsWithPermission } from "../auth/access.js";
import {
  assertCanActOnUser,
  createRole,
  deleteRole,
  duplicateRole,
  listRoles,
  RoleRuleError,
  updateRole,
  type RoleRow,
} from "../services/roles.js";
import { authErrorResponses, errorSchema } from "./shared.js";
import { apiError } from "../errors.js";

/**
 * Errore di regola con i campi in più: `count` di `role_in_use`, e
 * `permission` — la chiave che manca a chi agisce — dei 403 `escalation`
 * (dare permessi che non si hanno) e `target_above` (toccare utente, membro o
 * ruolo con più permessi dei propri), ruling R44.
 */
export const roleRuleErrorSchema = errorSchema.extend({
  count: z.number().int().optional(),
  permission: z.string().optional(),
});

/** Traduce un {@link RoleRuleError} in risposta; rilancia il resto. */
export function sendRoleRuleError(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof RoleRuleError)) throw error;
  return reply
    .code(error.status)
    .send({ code: error.code, message: error.message, ...error.extra });
}

/**
 * `preHandler` delle rotte di `users.manage` che agiscono su un altro utente
 * (`:id` del path): applica {@link assertCanActOnUser} (ruling R31). Gira dopo
 * l'hook globale di `config.access`, quindi `request.user` c'è.
 */
export function targetUserNotAbove(param = "id") {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = (request.params as Record<string, string>)[param]!;
    try {
      await assertCanActOnUser(request.server.db, request.user!, userId);
    } catch (error) {
      await sendRoleRuleError(reply, error);
    }
  };
}

export function toRoleView(row: RoleRow): z.infer<typeof roleSchema> {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const idParamsSchema = z.object({ id: z.uuid() });
const ruleErrors = {
  400: roleRuleErrorSchema,
  403: roleRuleErrorSchema,
  404: roleRuleErrorSchema,
  409: roleRuleErrorSchema,
};

/**
 * Catalogo dei ruoli, sotto /api/roles. Lo gestisce chi ha `roles.manage`.
 * L'elenco serve anche a chi deve SCEGLIERE un ruolo: chi gestisce i membri di
 * almeno un progetto, e chi invita o gestisce utenti (ruolo d'istanza).
 */
export async function roleRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    {
      config: { access: { kind: "user" } },
      schema: {
        querystring: z.object({ scope: roleScopeSchema.optional() }),
        response: { 200: z.array(roleSchema), ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const perms = user.instancePermissions;
      if (!perms.has("roles.manage") && !perms.has("users.manage") && !perms.has("users.invite")) {
        const managed = await projectIdsWithPermission(app.db, user, "project.members.manage");
        if (managed !== "all" && managed.length === 0) {
          return apiError(reply, 403, "forbidden", "Missing permission");
        }
      }
      return (await listRoles(app.db, request.query.scope)).map(toRoleView);
    },
  );

  app.post(
    "/",
    {
      config: { access: { kind: "instance", permission: "roles.manage" }, reauth: true },
      schema: {
        body: createRoleSchema,
        response: { 201: roleSchema, ...authErrorResponses, ...ruleErrors },
      },
    },
    async (request, reply) => {
      try {
        const role = await createRole(app.db, request.user!, request.body);
        return reply.code(201).send(toRoleView(role));
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  // Letterale `/duplicate` sotto `/:id`: segmenti diversi da `PATCH/DELETE
  // /:id`, nessuna ambiguità di routing (vedi la trappola nel CLAUDE.md).
  app.post(
    "/:id/duplicate",
    {
      config: { access: { kind: "instance", permission: "roles.manage" }, reauth: true },
      schema: {
        params: idParamsSchema,
        body: duplicateRoleSchema,
        response: { 201: roleSchema, ...authErrorResponses, ...ruleErrors },
      },
    },
    async (request, reply) => {
      try {
        const role = await duplicateRole(
          app.db,
          request.user!,
          request.params.id,
          request.body.name,
        );
        return reply.code(201).send(toRoleView(role));
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  app.patch(
    "/:id",
    {
      config: { access: { kind: "instance", permission: "roles.manage" }, reauth: true },
      schema: {
        params: idParamsSchema,
        body: updateRoleSchema,
        response: { 200: roleSchema, ...authErrorResponses, ...ruleErrors },
      },
    },
    async (request, reply) => {
      try {
        const role = await updateRole(app.db, request.user!, request.params.id, request.body);
        return reply.code(200).send(toRoleView(role));
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );

  app.delete(
    "/:id",
    {
      config: { access: { kind: "instance", permission: "roles.manage" }, reauth: true },
      schema: {
        params: idParamsSchema,
        response: { 204: z.null(), ...authErrorResponses, ...ruleErrors },
      },
    },
    async (request, reply) => {
      try {
        await deleteRole(app.db, request.user!, request.params.id);
        return reply.code(204).send(null);
      } catch (error) {
        return sendRoleRuleError(reply, error);
      }
    },
  );
}
