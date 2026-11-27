import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createRoleSchema,
  duplicateRoleSchema,
  roleSchema,
  roleScopeSchema,
  updateRoleSchema,
} from "@stubwise/shared";
import { projectIdsWithPermission, projectPermissionsFor, isAllProjects } from "../auth/access.js";
import {
  createRole,
  deleteRole,
  duplicateRole,
  listRoles,
  RoleRuleError,
  roleEditLastManager,
  updateRole,
  type RoleRow,
} from "../services/roles.js";
import type { SessionUser } from "../auth/session.js";
import { projects } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { authErrorResponses, errorSchema } from "./shared.js";
import { viewerLosesIf } from "../services/access-query.js";
import { apiError } from "../errors.js";

/**
 * Errore di regola con i campi in più: `count` di `role_in_use`, e
 * `permission` — la chiave che manca a chi agisce — del 403 `escalation`
 * (dare permessi che non si hanno), ruling R44. Il bersaglio non è più
 * protetto (area 9, D-2): `target_above` non esiste più.
 */
export const roleRuleErrorSchema = errorSchema.extend({
  count: z.number().int().optional(),
  permission: z.string().optional(),
  /** `escalation`: tutto ciò che a chi agisce manca (rimandi, lotto 4). */
  missing: z.array(z.string()).optional(),
  /** `last_manager` (lotto 3 delle workspace): il progetto, SOLO a chi lo vede. */
  projectId: z.uuid().optional(),
  projectCode: z.string().nullable().optional(),
});

/**
 * Il progetto di un `last_manager`, SOLO se chi guarda lo vede (r.1414,
 * invisibile = 404 senza eccezioni; la stessa regola dei reparti).
 */
async function lastManagerProject(app: FastifyInstance, viewer: SessionUser, projectId: string | null): Promise<{ projectId: string; projectCode: string | null } | null> {
  if (!projectId || !(await projectPermissionsFor(app.db, viewer, projectId, { includeArchived: true }))) return null;
  const [p] = await app.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  return p ? { projectId, projectCode: p.code } : null;
}

/** Traduce un {@link RoleRuleError} in risposta; rilancia il resto. */
export function sendRoleRuleError(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof RoleRuleError)) throw error;
  return reply
    .code(error.status)
    .send({ code: error.code, message: error.message, ...error.extra });
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
      config: { mcp: { action: "roles.list", summary: "I ruoli (d'istanza e di progetto) coi loro permessi.", effect: "read" }, access: { kind: "user" } },
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
        if (!isAllProjects(managed) && managed.length === 0) {
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

  // «You'd lose» (rimandi, lotto 5): cosa perderebbe chi guarda salvando il
  // ruolo con questi permessi. Lettura calcolata (POST per il corpo), nessuna
  // scrittura: niente riconferma.
  app.post(
    "/:id/viewer-loses",
    {
      config: { mcp: { action: "roles.viewerLoses", summary: "Anteprima: quali permessi perderesti TU se il ruolo avesse questi permessi, e se un progetto resterebbe senza chi ne gestisce i membri. Non scrive niente.", effect: "write", note: "È solo un calcolo: il ruolo si cambia dall'app (chiede la riconferma)." }, access: { kind: "instance", permission: "roles.manage" } },
      schema: {
        params: idParamsSchema,
        body: z.object({ permissions: z.array(z.string().max(100)).max(200) }),
        response: {
          200: z.object({
            lost: z.array(z.string()),
            /**
             * Lotto 3 delle workspace (46): salvando, un progetto resterebbe
             * senza gestore dei membri (`409 last_manager`). `blocked` lo dice
             * a tutti, il progetto solo a chi lo vede. Additivo.
             */
            lastManager: z
              .object({ blocked: z.boolean(), projectId: z.uuid().nullable(), projectCode: z.string().nullable() })
              .default({ blocked: false, projectId: null, projectCode: null }),
          }),
          ...authErrorResponses,
          ...ruleErrors,
        },
      },
    },
    async (request, reply) => {
      try {
        const blocked = await roleEditLastManager(app.db, request.params.id, request.body.permissions);
        const shown = await lastManagerProject(app, request.user!, blocked);
        return {
          lost: await viewerLosesIf(app.db, request.user!, request.params.id, request.body.permissions),
          lastManager: { blocked: blocked !== null, projectId: shown?.projectId ?? null, projectCode: shown?.projectCode ?? null },
        };
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
        if (error instanceof RoleRuleError && error.code === "last_manager") {
          const shown = await lastManagerProject(app, request.user!, typeof error.extra.projectId === "string" ? error.extra.projectId : null);
          return reply.code(409).send({ code: error.code, message: error.message, ...(shown ?? {}) });
        }
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
