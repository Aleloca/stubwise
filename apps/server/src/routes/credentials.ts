import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { credentials } from "@stubwise/db";
import {
  credentialAccessLogResponseSchema,
  credentialCreateBodySchema,
  credentialItemSchema,
  credentialListResponseSchema,
  credentialPasswordBodySchema,
  credentialRecipientsChangedSchema,
  credentialRecipientsSchema,
  credentialRevealBodySchema,
  credentialRevealResponseSchema,
  credentialUpdateBodySchema,
  type CredentialRecipients,
  type ProjectPermission,
} from "@stubwise/shared";
import {
  inProjects,
  projectPermissionsMap,
  routePermissions,
  visibleProjectIds,
  type RouteAccess,
} from "../auth/access.js";
import { fromParam } from "../auth/project-resolvers.js";
import { apiError } from "../errors.js";
import {
  canEditCredential,
  createCredential,
  credentialRecipients,
  credentialVisible,
  deleteCredential,
  fromCredential,
  listAccessLog,
  listMyCredentials,
  listProjectCredentials,
  managesCredentials,
  replacePassword,
  revealCredential,
  updateCredential,
  type WriteOutcome,
} from "../vault/credentials-service.js";
import { VaultNotActiveError } from "../vault/readers.js";
import { authErrorResponses, errorSchema } from "./shared.js";

const errorResponses = {
  ...authErrorResponses,
  404: errorSchema,
  409: errorSchema,
} as const;

/** Il 409 delle scritture cifrate: `recipients_changed` porta i destinatari attuali. */
const writeErrorResponses = {
  ...errorResponses,
  409: z.union([credentialRecipientsChangedSchema, errorSchema]),
} as const;

const projectParams = z.object({ projectId: z.uuid() });
const credentialParams = z.object({ id: z.uuid() });

/**
 * Una rotta su UNA credenziale (`:id`): basta vedere il progetto, e la
 * credenziale dev'essere nota a chi chiede (lettore, gestore o creatore —
 * `credentialVisible`); altrimenti 404 come una risorsa invisibile. Il
 * permesso dell'azione (`credentials.edit` o creatore) lo decide l'handler.
 */
const credentialAccess: RouteAccess = {
  kind: "project",
  permission: "member",
  project: fromCredential("id"),
  resource: credentialVisible("id"),
};

/**
 * Credenziali della cassaforte (design
 * `docs/plans/2026-10-23-cassaforte-credenziali-design.md`). Registrate con
 * prefisso `/api`: `/projects/:projectId/credentials...`, `/credentials/:id...`
 * e `/vault/credentials` («le mie»).
 *
 * Un PAT crea credenziali, sostituisce password, modifica ed elimina (lo
 * script d'inserimento del maintainer), ma non scarica MAI una copia della
 * chiave: `reveal` è solo da sessione (403 `session_required`). Nessun corpo
 * finisce nei log; nessuna risposta tranne `reveal` porta la password cifrata
 * o una copia della chiave.
 */
export async function credentialRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  function vaultNotActive(reply: FastifyReply): FastifyReply {
    return apiError(reply, 409, "vault_not_active", "The vault has not been activated");
  }

  function forbidden(reply: FastifyReply): FastifyReply {
    return apiError(reply, 403, "forbidden", "Missing permission");
  }

  function notFound(reply: FastifyReply): FastifyReply {
    return apiError(reply, 404, "not_found", "Not found");
  }

  /** L'esito di una scrittura cifrata (creazione, password) come risposta. */
  function sendWrite<T>(reply: FastifyReply, outcome: WriteOutcome<T>, status: 200 | 201): FastifyReply {
    if (outcome.ok) return reply.code(status).send(outcome.value);
    switch (outcome.error) {
      case "vault_not_active":
        return vaultNotActive(reply);
      case "not_found":
        return notFound(reply);
      case "credential_exists":
        return apiError(reply, 409, "credential_exists", "A credential with this id already exists");
      case "recipients_changed":
        return reply.code(409).send({
          code: "recipients_changed",
          message: "The recipients changed: encrypt for the current ones and retry",
          recipients: outcome.recipients,
        });
    }
  }

  async function recipientsOr409(
    reply: FastifyReply,
    load: () => Promise<CredentialRecipients>,
  ): Promise<FastifyReply> {
    try {
      return reply.code(200).send(await load());
    } catch (error) {
      if (error instanceof VaultNotActiveError) return vaultNotActive(reply);
      throw error;
    }
  }

  /* ── Rotte con parte letterale, PRIMA di quelle parametriche (CLAUDE.md). ── */

  /** «Le mie»: lette o in attesa, in tutti i progetti visibili. PAT ammesso (niente cifrati). */
  app.get(
    "/vault/credentials",
    {
      config: { access: { kind: "user" } },
      schema: { response: { 200: credentialListResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const user = request.user!;
      const visible = await visibleProjectIds(app.db, user);
      const items = await listMyCredentials(
        app.db,
        user,
        inProjects(credentials.projectId, visible),
        await projectPermissionsMap(app.db, user),
      );
      return reply.code(200).send({ items });
    },
  );

  /** Destinatari di una credenziale NUOVA del progetto (chi crea + full admin, più il recupero). */
  app.get(
    "/projects/:projectId/credentials/recipients",
    {
      config: {
        access: { kind: "project", permission: "credentials.create", project: fromParam("projectId") },
      },
      schema: { params: projectParams, response: { 200: credentialRecipientsSchema, ...errorResponses } },
    },
    async (request, reply) =>
      recipientsOr409(reply, () =>
        credentialRecipients(app.db, { projectId: request.params.projectId, creatorUserId: request.user!.id }),
      ),
  );

  /** Registro delle letture: `credentials.edit` o `credentials.share` (un full admin li ha). */
  app.get(
    "/projects/:projectId/credentials/log",
    {
      config: { access: { kind: "project", permission: "member", project: fromParam("projectId") } },
      schema: {
        params: projectParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }),
        response: { 200: credentialAccessLogResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!managesCredentials(routePermissions(request))) return forbidden(reply);
      const items = await listAccessLog(app.db, request.params.projectId, request.query.limit);
      return reply.code(200).send({ items });
    },
  );

  /** Elenco del progetto: chi non legge e non gestisce non vede nulla. */
  app.get(
    "/projects/:projectId/credentials",
    {
      config: { access: { kind: "project", permission: "member", project: fromParam("projectId") } },
      schema: { params: projectParams, response: { 200: credentialListResponseSchema, ...errorResponses } },
    },
    async (request, reply) => {
      const items = await listProjectCredentials(
        app.db,
        request.user!,
        request.params.projectId,
        routePermissions(request),
      );
      return reply.code(200).send({ items });
    },
  );

  /**
   * Crea una credenziale con la password GIÀ cifrata e le copie della chiave
   * per ESATTAMENTE i destinatari attuali (`.../recipients`); altrimenti 409
   * `recipients_changed` coi destinatari nuovi e nessuna riga. PAT ammesso.
   */
  app.post(
    "/projects/:projectId/credentials",
    {
      config: {
        access: { kind: "project", permission: "credentials.create", project: fromParam("projectId") },
      },
      schema: {
        params: projectParams,
        body: credentialCreateBodySchema,
        response: { 201: credentialItemSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const outcome = await createCredential(
        app.db,
        request.user!,
        request.params.projectId,
        routePermissions(request),
        request.body,
      );
      return sendWrite(reply, outcome, 201);
    },
  );

  /**
   * Mostra o copia. Solo da sessione: un PAT riceve 403 `session_required`
   * PRIMA di ogni altro controllo (per questo l'accesso è `user` e non
   * `project`: l'hook risponderebbe 404 a un progetto invisibile prima che il
   * PAT si possa rifiutare). Chi non la legge ADESSO → 404 `not_found`, come
   * una credenziale che non esiste o un progetto invisibile.
   */
  app.post(
    "/credentials/:id/reveal",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: credentialParams,
        body: credentialRevealBodySchema,
        response: { 200: credentialRevealResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      if (user.patId !== undefined || user.sessionId === undefined) {
        return apiError(reply, 403, "session_required", "This action requires a browser session");
      }
      const revealed = await revealCredential(app.db, user, request.params.id, request.body.action);
      if (!revealed) return notFound(reply);
      return reply.code(200).send(revealed);
    },
  );

  /** Destinatari attuali di una credenziale (per cambiarne la password). */
  app.get(
    "/credentials/:id/recipients",
    {
      config: { access: credentialAccess },
      schema: { params: credentialParams, response: { 200: credentialRecipientsSchema, ...errorResponses } },
    },
    async (request, reply) => {
      if (!(await mayEdit(request.user!.id, routePermissions(request), request.params.id))) {
        return forbidden(reply);
      }
      return recipientsOr409(reply, () => credentialRecipients(app.db, request.params.id));
    },
  );

  /** Sostituisce password e TUTTE le copie (stesso controllo dei destinatari della creazione). */
  app.put(
    "/credentials/:id/password",
    {
      config: { access: credentialAccess },
      schema: {
        params: credentialParams,
        body: credentialPasswordBodySchema,
        response: { 200: credentialItemSchema, ...writeErrorResponses },
      },
    },
    async (request, reply) => {
      const permissions = routePermissions(request);
      if (!(await mayEdit(request.user!.id, permissions, request.params.id))) return forbidden(reply);
      const outcome = await replacePassword(app.db, request.user!, request.params.id, permissions, request.body);
      return sendWrite(reply, outcome, 200);
    },
  );

  /** Modifica i campi in chiaro. */
  app.patch(
    "/credentials/:id",
    {
      config: { access: credentialAccess },
      schema: {
        params: credentialParams,
        body: credentialUpdateBodySchema,
        response: { 200: credentialItemSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const permissions = routePermissions(request);
      if (!(await mayEdit(request.user!.id, permissions, request.params.id))) return forbidden(reply);
      const item = await updateCredential(app.db, request.user!, request.params.id, permissions, request.body);
      if (!item) return notFound(reply);
      return reply.code(200).send(item);
    },
  );

  /** Elimina la credenziale (il registro resta, con la fotografia in testo). */
  app.delete(
    "/credentials/:id",
    {
      config: { access: credentialAccess },
      schema: { params: credentialParams, response: { 204: z.null(), ...errorResponses } },
    },
    async (request, reply) => {
      if (!(await mayEdit(request.user!.id, routePermissions(request), request.params.id))) {
        return forbidden(reply);
      }
      if (!(await deleteCredential(app.db, request.params.id))) return notFound(reply);
      return reply.code(204).send(null);
    },
  );

  function mayEdit(userId: string, permissions: ReadonlySet<ProjectPermission>, id: string): Promise<boolean> {
    return canEditCredential(app.db, userId, permissions, id);
  }
}
