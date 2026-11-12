import { mailComposeModeSchema, mailDraftListSchema, mailDraftSaveSchema, mailDraftSchema } from "@stubwise/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import { discardDraft, draftFor, listDrafts, realMailComposeClient, saveDraft, type DraftError, type MailComposeClient } from "../services/mail-drafts.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * LE BOZZE (area 6, fetta 3), sotto `/api/me/mail/drafts`: le regole stanno in
 * `services/mail-drafts.ts`. Registrate PRIMA di `meMailRoutes` (la parte
 * letterale `/drafts` sullo stesso prefisso di `/:source/:id`).
 */
export async function meMailDraftsRoutes(instance: FastifyInstance, opts: { client?: MailComposeClient }): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const client = opts.client ?? realMailComposeClient;
  const errors = { 404: errorSchema, 409: errorSchema.extend({ missing: z.array(z.string()).optional() }), 502: errorSchema, ...authErrorResponses };

  function sendError(reply: FastifyReply, err: DraftError) {
    switch (err.error) {
      case "not_found":
        return apiError(reply, 404, "not_found", "Not found");
      case "google_scope_missing":
        return reply.code(409).send({ code: err.error, message: "Reconnect the mailbox to write from Stubwise", missing: err.missing });
      case "google_unavailable":
        return apiError(reply, 502, err.error, "Could not reach Google");
      default:
        return apiError(reply, 409, err.error, "Cannot save the draft");
    }
  }

  app.get(
    "/",
    { config: { access: { kind: "user" } }, schema: { response: { 200: mailDraftListSchema, ...authErrorResponses } } },
    async (request) => ({ items: await listDrafts(app.db, request.user!.id) }),
  );

  /** «La bozza di»: quella salvata, o una nuova già indirizzata. Non salva. */
  app.get(
    "/compose",
    {
      config: { access: { kind: "user" } },
      schema: {
        querystring: z.object({ account: z.uuid(), thread: z.string().max(200).optional(), mode: mailComposeModeSchema, replyTo: z.uuid().optional() }),
        response: { 200: mailDraftSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      const out = await draftFor(app.db, request.user!.id, {
        accountId: request.query.account,
        threadId: request.query.thread ?? null,
        mode: request.query.mode,
        replyToMessageId: request.query.replyTo ?? null,
      });
      if ("error" in out) return apiError(reply, 404, "not_found", "Not found");
      return out;
    },
  );

  /** Salva: crea o sostituisce la bozza dello slot, su Gmail. */
  app.put(
    "/",
    { config: { access: { kind: "user" } }, schema: { body: mailDraftSaveSchema, response: { 200: mailDraftSchema, ...errors } } },
    async (request, reply) => {
      const out = await saveDraft(app.db, app.encryptionKey, client, request.user!.id, request.body);
      if ("error" in out) return sendError(reply, out);
      return out;
    },
  );

  app.delete(
    "/:id",
    { config: { access: { kind: "user" } }, schema: { params: z.object({ id: z.uuid() }), response: { 204: z.null(), ...errors } } },
    async (request, reply) => {
      const out = await discardDraft(app.db, app.encryptionKey, client, request.user!.id, request.params.id);
      if ("error" in out) return sendError(reply, out);
      return reply.code(204).send(null);
    },
  );
}
