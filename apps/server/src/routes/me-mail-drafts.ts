import { mailComposeModeSchema, mailDraftListSchema, mailDraftRestoreSchema, mailDraftSaveSchema, mailDraftSchema, mailOutgoingSchema, mailRecipientSuggestionListSchema } from "@stubwise/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import {
  attachDriveFile,
  attachUploadedFile,
  discardDraft,
  draftFor,
  listDrafts,
  realMailComposeClient,
  removeAttachment,
  saveDraft,
  DRAFT_MAX_ATTACHMENT_BYTES,
  type DraftError,
  type MailComposeClient,
} from "../services/mail-drafts.js";
import { isMultipartLimit } from "./multipart.js";
import { suggestRecipients } from "../services/mail-recipients.js";
import { MAIL_DRAFT_DEFAULT_MODEL, MAIL_DRAFT_OPERATION, prepareClaudeDraft, usedTasks } from "../services/mail-claude-draft.js";
import { monthlyBudgetExhausted } from "../services/agent-sessions.js";
import { writeSseEvent } from "./docs-chat-core.js";
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
      case "too_many_attachments":
      case "too_large":
      case "storage_not_configured":
        return apiError(reply, 400, err.error, "Cannot attach this file");
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
      }, { encryptionKey: app.encryptionKey, client });
      if ("error" in out) return apiError(reply, 404, "not_found", "Not found");
      return out;
    },
  );

  /** Salva: crea o sostituisce la bozza dello slot, su Gmail. */
  app.put(
    "/",
    { config: { access: { kind: "user" } }, schema: { body: mailDraftSaveSchema, response: { 200: mailDraftSchema, ...errors } } },
    async (request, reply) => {
      const out = await saveDraft(app.db, app.encryptionKey, client, await app.storage(), request.user!.id, request.body);
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

  /**
   * «Chiedi a Claude» (F3, task 6): il corpo dell'email in SSE — `delta` coi
   * pezzi, poi `done` con `{ text, projectId, used }`, o `error` con
   * `claude_unavailable` a metà. Solo un testo: niente bozza salvata, niente
   * invio. I rifiuti arrivano PRIMA dello stream, in JSON: 404 (casella,
   * conversazione o progetto che non vedo), 400 `invalid_hint`, 409
   * `budget_exhausted`, 503 `claude_unavailable`.
   */
  app.post(
    "/claude",
    {
      config: { access: { kind: "user" } },
      schema: {
        body: z.object({
          accountId: z.uuid(),
          threadId: z.string().max(200).nullable().default(null),
          mode: mailComposeModeSchema,
          hint: z.string().max(2000).default(""),
          projectId: z.uuid().nullable().default(null),
        }),
        response: { 400: errorSchema, 503: errorSchema, ...errors },
      },
    },
    async (request, reply) => {
      const prepared = await prepareClaudeDraft(app.db, request.user!.id, request.body);
      if ("error" in prepared) {
        return prepared.error === "not_found"
          ? apiError(reply, 404, "not_found", "Not found")
          : apiError(reply, 400, "invalid_hint", "A new email needs an instruction");
      }
      if (await monthlyBudgetExhausted(app.db)) return apiError(reply, 409, "budget_exhausted", "The monthly AI budget is used up");
      const availability = (await app.chatLlm.isAvailable?.()) ?? { available: true };
      if (!availability.available) return apiError(reply, 503, "claude_unavailable", "Claude is not available");

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Chi chiude il compositore ferma anche la generazione (e il consumo).
      const controller = new AbortController();
      let gone = false;
      request.raw.on("close", () => {
        gone = true;
        controller.abort();
      });
      let text = "";
      try {
        for await (const delta of app.chatLlm.stream({
          system: prepared.system,
          messages: prepared.messages,
          signal: controller.signal,
          usage: { operation: MAIL_DRAFT_OPERATION, projectId: prepared.projectId, defaultModel: MAIL_DRAFT_DEFAULT_MODEL },
        })) {
          if (gone) break;
          text += delta;
          writeSseEvent(reply, { type: "delta", text: delta });
        }
        if (!gone) {
          writeSseEvent(reply, {
            type: "done",
            text,
            projectId: prepared.projectId,
            used: usedTasks(text, prepared.tasks),
          });
        }
      } catch (err) {
        request.log.error({ err }, "mail draft: generazione fallita");
        if (!gone) writeSseEvent(reply, { type: "error", code: "claude_unavailable" });
      } finally {
        if (!gone) reply.raw.end();
      }
    },
  );

  const attachErrors = { 400: errorSchema, ...errors };

  /** Un allegato dal disco (multipart, un file, al più 25 MB in tutto). */
  app.post(
    "/:id/attachments",
    { config: { access: { kind: "user" } }, schema: { params: z.object({ id: z.uuid() }), response: { 200: mailDraftSchema, ...attachErrors } } },
    async (request, reply) => {
      let part;
      try {
        part = await request.file({ limits: { fileSize: DRAFT_MAX_ATTACHMENT_BYTES, files: 1, fields: 0, parts: 1 } });
      } catch (error) {
        if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return apiError(reply, 400, "too_large", "Attachments exceed 25 MB");
        if (isMultipartLimit(error)) return apiError(reply, 400, "invalid_multipart", "Send one file and nothing else");
        throw error;
      }
      if (!part) return apiError(reply, 400, "file_required", "A file is required");
      let content: Buffer;
      try {
        content = await part.toBuffer();
      } catch (error) {
        if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return apiError(reply, 400, "too_large", "Attachments exceed 25 MB");
        throw error;
      }
      const out = await attachUploadedFile(app.db, app.encryptionKey, client, await app.storage(), request.user!.id, request.params.id, {
        name: part.filename,
        mimeType: part.mimetype,
        content,
      });
      return "error" in out ? sendError(reply, out) : out;
    },
  );

  /** Un file del Drive del progetto (copia, letta col permesso di chi scrive). */
  app.post(
    "/:id/attachments/drive",
    {
      config: { access: { kind: "user" } },
      schema: { params: z.object({ id: z.uuid() }), body: z.object({ driveFileId: z.uuid() }), response: { 200: mailDraftSchema, ...attachErrors } },
    },
    async (request, reply) => {
      const out = await attachDriveFile(app.db, app.encryptionKey, client, await app.storage(), request.user!.id, request.params.id, request.body.driveFileId);
      return "error" in out ? sendError(reply, out) : out;
    },
  );

  app.delete(
    "/:id/attachments/:attachmentId",
    {
      config: { access: { kind: "user" } },
      schema: { params: z.object({ id: z.uuid(), attachmentId: z.uuid() }), response: { 200: mailDraftSchema, ...attachErrors } },
    },
    async (request, reply) => {
      const out = await removeAttachment(app.db, app.encryptionKey, client, await app.storage(), request.user!.id, request.params.id, request.params.attachmentId);
      return "error" in out ? sendError(reply, out) : out;
    },
  );

  /** Invia: il server lo trattiene 10 s (D6); un doppio Invia dà lo stesso invio. */
  app.post(
    "/:id/send",
    {
      config: { access: { kind: "user" } },
      schema: {
        params: z.object({ id: z.uuid() }),
        response: {
          202: mailOutgoingSchema,
          400: errorSchema.extend({ address: z.string().optional() }),
          404: errorSchema,
          409: errorSchema.extend({ missing: z.array(z.string()).optional() }),
          ...authErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const out = await sendDraftLater(app.db, request.user!.id, request.params.id);
      if ("messageId" in out) return reply.code(202).send(out);
      switch (out.error) {
        case "invalid_recipients":
        case "too_many_attachments":
        case "too_large":
          return apiError(reply, 400, out.error, "The draft cannot be sent as it is");
        case "invalid_address":
          return reply.code(400).send({ code: out.error, message: "An address is not valid", address: out.address });
        case "google_scope_missing":
          return reply.code(409).send({ code: out.error, message: "Reconnect the mailbox to send from Stubwise", missing: out.missing });
        case "attachment_unavailable":
        case "account_disabled":
          return apiError(reply, 409, out.error, "The draft cannot be sent now");
        default:
          return apiError(reply, 404, "not_found", "Draft not found");
      }
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

/** I destinatari suggeriti mentre si scrive un indirizzo (F3, task 5). */
export async function meMailRecipientsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/",
    {
      config: { access: { kind: "user" } },
      schema: { querystring: z.object({ q: z.string().max(200).default("") }), response: { 200: mailRecipientSuggestionListSchema, ...authErrorResponses } },
    },
    async (request) => ({ items: await suggestRecipients(app.db, request.user!, request.query.q) }),
  );
}

