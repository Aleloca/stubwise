import {
  addGoogleFileBodySchema,
  driveFileRowSchema,
  driveFolderLinkListSchema,
  driveFolderLinkSchema,
  googleFileChoiceListSchema,
  googleFolderChoiceListSchema,
  linkGoogleFolderBodySchema,
  setDriveHiddenBodySchema,
} from "@stubwise/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import {
  addGoogleFile,
  DriveGoogleError,
  linkGoogleFolder,
  listGoogleChoices,
  listGoogleFolderChoices,
  listGoogleOutside,
  listMyFolderLinks,
  listProjectFolderLinks,
  openGoogleFile,
  realDriveGoogleClient,
  requestFolderSync,
  setDriveFileHidden,
  unlinkGoogleFolder,
  type DriveGoogleClient,
} from "../drive/google.js";
import { DriveError } from "../drive/service.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * GOOGLE DRIVE NEL DRIVE DEI PROGETTI (area 6, F5b), sotto `/api`. Le regole
 * in `drive/google.ts`; le rotte sono `{ kind: "user" }` come quelle del
 * Drive (vedere vuol dire essere membri; i permessi li controlla il servizio).
 * Registrate PRIMA di `driveRoutes`: le parti letterali `/drive/google/…`
 * stanno sullo stesso prefisso di `/drive/files/:id`.
 */

const ACCESS = { kind: "user" } as const;
const errors = {
  ...authErrorResponses,
  400: errorSchema,
  404: errorSchema,
  409: errorSchema.extend({ missing: z.array(z.string()).optional() }),
  502: errorSchema,
};
const q = z.object({ q: z.string().trim().max(200).optional() });

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DriveGoogleError && error.missing) return reply.code(error.status).send({ code: error.code, message: error.message, missing: error.missing });
    if (error instanceof DriveError) return apiError(reply, error.status, error.code, error.message);
    throw error;
  }
}

export async function driveGoogleRoutes(instance: FastifyInstance, opts: { client?: DriveGoogleClient }): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const deps = () => ({ db: app.db, encryptionKey: app.encryptionKey, client: opts.client ?? realDriveGoogleClient });
  const projectParams = z.object({ projectId: z.uuid() });
  const idParams = z.object({ id: z.uuid() });

  app.get(
    "/projects/:projectId/drive/google/files",
    { config: { access: ACCESS }, schema: { params: projectParams, querystring: q, response: { 200: googleFileChoiceListSchema, ...errors } } },
    async (request, reply) => handle(reply, async () => ({ items: await listGoogleChoices(deps(), request.user!, request.params.projectId, request.query.q) })),
  );

  app.post(
    "/projects/:projectId/drive/google/files",
    { config: { access: ACCESS }, schema: { params: projectParams, body: addGoogleFileBodySchema, response: { 201: driveFileRowSchema, ...errors } } },
    async (request, reply) => handle(reply, async () => reply.code(201).send(await addGoogleFile(deps(), request.user!, request.params.projectId, request.body.googleFileId))),
  );

  app.get(
    "/projects/:projectId/drive/google/folders",
    { config: { access: ACCESS }, schema: { params: projectParams, querystring: q, response: { 200: googleFolderChoiceListSchema, ...errors } } },
    async (request, reply) => handle(reply, async () => ({ items: await listGoogleFolderChoices(deps(), request.user!, request.params.projectId, request.query.q) })),
  );

  app.post(
    "/projects/:projectId/drive/google/folders",
    { config: { access: ACCESS }, schema: { params: projectParams, body: linkGoogleFolderBodySchema, response: { 201: driveFolderLinkSchema, ...errors } } },
    async (request, reply) => handle(reply, async () => reply.code(201).send(await linkGoogleFolder(deps(), request.user!, request.params.projectId, request.body.googleFolderId))),
  );

  app.get(
    "/projects/:projectId/drive/google/links",
    { config: { access: ACCESS }, schema: { params: projectParams, response: { 200: driveFolderLinkListSchema, ...errors } } },
    async (request, reply) => handle(reply, async () => ({ items: await listProjectFolderLinks(app.db, request.user!, request.params.projectId) })),
  );

  app.get(
    "/drive/google/links",
    { config: { access: ACCESS }, schema: { response: { 200: driveFolderLinkListSchema, ...errors } } },
    async (request, reply) => handle(reply, async () => ({ items: await listMyFolderLinks(app.db, request.user!) })),
  );

  app.get(
    "/drive/google/outside",
    { config: { access: ACCESS }, schema: { querystring: q, response: { 200: googleFileChoiceListSchema, ...errors } } },
    async (request, reply) => handle(reply, async () => ({ items: await listGoogleOutside(deps(), request.user!, request.query.q) })),
  );

  app.post(
    "/drive/google/folders/:id/sync",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 200: driveFolderLinkSchema, ...errors } } },
    async (request, reply) => handle(reply, () => requestFolderSync(app.db, request.user!, request.params.id)),
  );

  app.delete(
    "/drive/google/folders/:id",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 204: z.null(), ...errors } } },
    async (request, reply) => handle(reply, async () => (await unlinkGoogleFolder(app.db, request.user!, request.params.id), reply.code(204).send(null))),
  );

  app.put(
    "/drive/files/:id/hidden",
    { config: { access: ACCESS }, schema: { params: idParams, body: setDriveHiddenBodySchema, response: { 200: driveFileRowSchema, ...errors } } },
    async (request, reply) => handle(reply, () => setDriveFileHidden(app.db, request.user!, request.params.id, request.body.hidden)),
  );

  // «Apri in Google Drive»: conta l'apertura (`via: google`) e porta su Google, che applica i permessi.
  app.get(
    "/drive/files/:id/open",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 302: z.null(), ...errors } } },
    async (request, reply) =>
      handle(reply, async () => {
        const url = await openGoogleFile(app.db, request.user!, request.params.id);
        if (!url) return apiError(reply, 404, "not_found", "Not found");
        return reply.redirect(url, 302);
      }),
  );
}
