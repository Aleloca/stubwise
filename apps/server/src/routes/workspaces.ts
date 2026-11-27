import { projects } from "@stubwise/db";
import {
  workspaceCandidatesSchema,
  workspaceCreateSchema,
  workspaceEffectRequestSchema,
  workspaceEffectSchema,
  workspaceListSchema,
  workspaceMemberPreviewSchema,
  workspaceUpdateSchema,
  workspaceViewSchema,
} from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { RoleRuleError } from "../services/roles.js";
import {
  accessEffect,
  addProject,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  memberPreview,
  putMember,
  removeMember,
  removeProject,
  updateWorkspace,
  workspaceCandidates,
} from "../services/workspaces.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * WORKSPACE (lotto 3, `docs/plans/2026-11-27-workspace-design.md` §2.2): le
 * regole stanno in `services/workspaces.ts`; qui gli errori e la visibilità
 * del progetto di un errore (r.1414: id e codice solo a chi lo vede). La
 * riconferma la chiedono le scritture che fanno arrivare permessi (D11):
 * mettere una persona o cambiarne il ruolo, mettere un progetto.
 */

const MANAGE = { kind: "instance", permission: "workspaces.manage" } as const;
const CHANGES_ACCESS = "Cambia chi vede i progetti e cosa ci può fare: dillo all'utente nella riga che annuncia l'azione.";

const ruleErrorSchema = errorSchema.extend({
  permission: z.string().optional(),
  missing: z.array(z.string()).optional(),
  projectId: z.uuid().optional(),
  projectCode: z.string().nullable().optional(),
});
const ruleErrors = { 400: ruleErrorSchema, 403: ruleErrorSchema, 404: ruleErrorSchema, 409: ruleErrorSchema, 422: ruleErrorSchema };
const idParams = z.object({ id: z.uuid() });

export async function workspaceRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  /** Un errore di regola; il progetto (escalation, last_manager) solo a chi lo vede. */
  async function sendRuleError(reply: FastifyReply, viewer: SessionUser, error: unknown) {
    if (!(error instanceof RoleRuleError)) throw error;
    const { projectId, ...rest } = error.extra as { projectId?: unknown };
    let shown: { projectId: string; projectCode: string | null } | null = null;
    if (typeof projectId === "string" && (await projectPermissionsFor(app.db, viewer, projectId, { includeArchived: true }))) {
      const [p] = await app.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
      if (p) shown = { projectId, projectCode: p.code };
    }
    return reply.code(error.status).send({ code: error.code, message: error.message, ...rest, ...(shown ?? {}) });
  }

  app.get(
    "/",
    {
      config: { access: { kind: "user" }, mcp: { action: "workspaces.list", summary: "Le workspace che vedi, coi loro progetti (solo quelli che vedi) e le persone.", effect: "read" } },
      schema: { response: { 200: workspaceListSchema, ...authErrorResponses } },
    },
    async (request) => ({ items: await listWorkspaces(app.db, request.user!) }),
  );

  // Rotta letterale PRIMA delle parametriche (la trappola di routing di Fastify).
  app.post(
    "/effect",
    {
      config: {
        access: { kind: "user" },
        mcp: { action: "workspaces.effect", summary: "Anteprima di un cambio di workspace: chi comincia e chi smette di vedere ogni progetto. Non scrive niente.", effect: "write" },
      },
      schema: { body: workspaceEffectRequestSchema, response: { 200: workspaceEffectSchema, ...authErrorResponses, ...ruleErrors } },
    },
    async (request, reply) => {
      try {
        return await accessEffect(app.db, request.user!, request.body);
      } catch (error) {
        return sendRuleError(reply, request.user!, error);
      }
    },
  );

  app.get(
    "/:id",
    {
      config: { access: { kind: "user" }, mcp: { action: "workspaces.get", summary: "Una workspace: i suoi progetti che vedi e le sue persone.", effect: "read" } },
      schema: { params: idParams, response: { 200: workspaceViewSchema, ...authErrorResponses, ...ruleErrors } },
    },
    async (request, reply) => {
      try {
        return await getWorkspace(app.db, request.user!, request.params.id);
      } catch (error) {
        return sendRuleError(reply, request.user!, error);
      }
    },
  );

  app.post(
    "/",
    {
      config: { access: MANAGE, mcp: { action: "workspaces.create", summary: "Crea una workspace, anche coi suoi progetti.", effect: "write", note: CHANGES_ACCESS } },
      schema: { body: workspaceCreateSchema, response: { 201: workspaceViewSchema, ...authErrorResponses, ...ruleErrors } },
    },
    async (request, reply) => {
      try {
        return reply.code(201).send(await createWorkspace(app.db, request.user!, request.body));
      } catch (error) {
        return sendRuleError(reply, request.user!, error);
      }
    },
  );

  app.patch(
    "/:id",
    {
      config: { access: MANAGE, mcp: { action: "workspaces.update", summary: "Rinomina una workspace o ne cambia il colore.", effect: "write" } },
      schema: { params: idParams, body: workspaceUpdateSchema, response: { 200: workspaceViewSchema, ...authErrorResponses, ...ruleErrors } },
    },
    async (request, reply) => {
      try {
        return await updateWorkspace(app.db, request.user!, request.params.id, request.body);
      } catch (error) {
        return sendRuleError(reply, request.user!, error);
      }
    },
  );

  app.delete(
    "/:id",
    {
      config: { access: MANAGE, mcp: { action: "workspaces.delete", summary: "Elimina una workspace: i progetti restano, le sue persone smettono di vederli (se non ne sono membri).", effect: "destructive", note: CHANGES_ACCESS } },
      schema: { params: idParams, response: { 204: z.null(), ...authErrorResponses, ...ruleErrors } },
    },
    async (request, reply) => {
      try {
        await deleteWorkspace(app.db, request.user!, request.params.id);
        return reply.code(204).send(null);
      } catch (error) {
        return sendRuleError(reply, request.user!, error);
      }
    },
  );

  const projectParams = z.object({ id: z.uuid(), projectId: z.uuid() });

  // D11: mettere un progetto fa arrivare permessi a tutte le persone della workspace.
  app.put(
    "/:id/projects/:projectId",
    {
      config: { access: MANAGE, reauth: true },
      schema: { params: projectParams, response: { 200: workspaceViewSchema, ...authErrorResponses, ...ruleErrors } },
    },
    async (request, reply) => {
      try {
        return await addProject(app.db, request.user!, request.params.id, request.params.projectId);
      } catch (error) {
        return sendRuleError(reply, request.user!, error);
      }
    },
  );

  app.delete(
    "/:id/projects/:projectId",
    {
      config: { access: MANAGE, mcp: { action: "workspaces.removeProject", summary: "Toglie un progetto da una workspace: chi lo vedeva solo per lei smette di vederlo.", effect: "destructive", note: CHANGES_ACCESS } },
      schema: { params: projectParams, response: { 204: z.null(), ...authErrorResponses, ...ruleErrors } },
    },
    async (request, reply) => {
      try {
        await removeProject(app.db, request.user!, request.params.id, request.params.projectId);
        return reply.code(204).send(null);
      } catch (error) {
        return sendRuleError(reply, request.user!, error);
      }
    },
  );

  const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });
  const memberBody = z.object({ roleId: z.uuid().optional() });

  app.get(
    "/:id/candidates",
    {
      config: {
        access: { kind: "user" },
        mcp: { action: "workspaces.candidates", summary: "Chi puoi mettere in una workspace: le persone che vedi, coi ruoli che puoi dare in tutti i suoi progetti.", effect: "read" },
      },
      schema: { params: idParams, response: { 200: workspaceCandidatesSchema, ...authErrorResponses, ...ruleErrors } },
    },
    async (request, reply) => {
      try {
        return await workspaceCandidates(app.db, request.user!, request.params.id);
      } catch (error) {
        return sendRuleError(reply, request.user!, error);
      }
    },
  );

  app.post(
    "/:id/members/:userId/preview",
    {
      config: {
        access: { kind: "user" },
        mcp: { action: "workspaces.memberPreview", summary: "Anteprima: cosa guadagnerebbe una persona entrando in una workspace (o cambiando ruolo), e cosa non puoi darle. Non scrive niente.", effect: "write" },
      },
      schema: { params: memberParams, body: memberBody, response: { 200: workspaceMemberPreviewSchema, ...authErrorResponses, ...ruleErrors } },
    },
    async (request, reply) => {
      try {
        return await memberPreview(app.db, request.user!, request.params.id, request.params.userId, request.body);
      } catch (error) {
        return sendRuleError(reply, request.user!, error);
      }
    },
  );

  // D11: dà permessi in ogni progetto della workspace.
  app.put(
    "/:id/members/:userId",
    {
      config: { access: { kind: "user" }, reauth: true },
      schema: { params: memberParams, body: memberBody, response: { 200: workspaceViewSchema, ...authErrorResponses, ...ruleErrors } },
    },
    async (request, reply) => {
      try {
        return await putMember(app.db, request.user!, request.params.id, request.params.userId, request.body);
      } catch (error) {
        return sendRuleError(reply, request.user!, error);
      }
    },
  );

  app.delete(
    "/:id/members/:userId",
    {
      config: {
        access: { kind: "user" },
        mcp: { action: "workspaces.removeMember", summary: "Toglie una persona da una workspace (con alsoProjects, anche dai progetti dove era membro esplicito).", effect: "destructive", note: CHANGES_ACCESS },
      },
      schema: { params: memberParams, querystring: z.object({ alsoProjects: z.enum(["true", "false"]).optional() }), response: { 204: z.null(), ...authErrorResponses, ...ruleErrors } },
    },
    async (request, reply) => {
      try {
        await removeMember(app.db, request.user!, request.params.id, request.params.userId, { alsoProjects: request.query.alsoProjects === "true" });
        return reply.code(204).send(null);
      } catch (error) {
        return sendRuleError(reply, request.user!, error);
      }
    },
  );
}
