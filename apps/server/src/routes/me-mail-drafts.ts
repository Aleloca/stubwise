import { mailComposeModeSchema, mailDraftListSchema, mailDraftRestoreSchema, mailDraftSaveSchema, mailDraftSchema, mailOutgoingSchema } from "@stubwise/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import { discardDraft, draftFor, listDrafts, realMailComposeClient, saveDraft, type DraftError, type MailComposeClient } from "../services/mail-drafts.js";
import { discardFailedSend, getOutgoing, retrySend, sendDraftLater, undoSend, type SendError } from "../services/mail-send.js";
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

  /** Invia: il server lo trattiene 10 s (D6); un doppio Invia dà lo stesso invio. */
  app.post(
    "/:id/send",
    { config: { access: { kind: "user" } }, schema: { params: z.object({ id: z.uuid() }), response: { 202: mailOutgoingSchema, 404: errorSchema, ...authErrorResponses } } },
    async (request, reply) => {
      const out = await sendDraftLater(app.db, request.user!.id, request.params.id);
      if (!("messageId" in out)) return apiError(reply, 404, "not_found", "Draft not found");
      return reply.code(202).send(out);
    },
  );
}

/** Gli invii (area 6, F3, D6), sotto `/api/me/mail/outgoing`: solo di chi scrive. */
export async function meMailOutgoingRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ id: z.uuid() });
  const errors = { 404: errorSchema, 409: errorSchema, ...authErrorResponses };
  function sendError(reply: FastifyReply, err: SendError) {
    if (err.error === "not_found") return apiError(reply, 404, "not_found", "Not found");
    return apiError(reply, 409, err.error, "Cannot do that now");
  }

  app.get(
    "/:id",
    { config: { access: { kind: "user" } }, schema: { params, response: { 200: mailOutgoingSchema, ...errors } } },
    async (request, reply) => (await getOutgoing(app.db, request.user!.id, request.params.id)) ?? apiError(reply, 404, "not_found", "Not found"),
  );
  /** Annulla, prima che scadano i 10 s; dopo 409 `too_late`. */
  app.post(
    "/:id/undo",
    { config: { access: { kind: "user" } }, schema: { params, response: { 200: mailDraftRestoreSchema, ...errors } } },
    async (request, reply) => {
      const out = await undoSend(app.db, request.user!.id, request.params.id);
      return "error" in out ? sendError(reply, out) : out;
    },
  );
  /** Riprova un invio fallito (mai automatico). */
  app.post(
    "/:id/retry",
    { config: { access: { kind: "user" } }, schema: { params, response: { 202: mailOutgoingSchema, ...errors } } },
    async (request, reply) => {
      const out = await retrySend(app.db, request.user!.id, request.params.id);
      return "messageId" in out ? reply.code(202).send(out) : sendError(reply, out);
    },
  );
  /** Elimina un invio fallito: la bozza torna. */
  app.post(
    "/:id/discard",
    { config: { access: { kind: "user" } }, schema: { params, response: { 200: mailDraftRestoreSchema, ...errors } } },
    async (request, reply) => {
      const out = await discardFailedSend(app.db, request.user!.id, request.params.id);
      return "error" in out ? sendError(reply, out) : out;
    },
  );
}
