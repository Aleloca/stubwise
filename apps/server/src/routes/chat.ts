import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  chatAttachmentSchema,
  chatChannelListQuerySchema,
  chatChannelListSchema,
  chatChannelPrefSchema,
  chatChannelSchema,
  chatClaudeQuestionListSchema,
  answerChatClaudeQuestionSchema,
  chatMentionListSchema,
  chatMessagePageQuerySchema,
  chatMessagePageSchema,
  chatMessageSchema,
  chatQuestionListSchema,
  chatReactionBodySchema,
  chatSearchQuerySchema,
  chatSearchResultSchema,
  chatSignalSchema,
  chatThreadFollowSchema,
  chatThreadNewsSchema,
  chatThreadSchema,
  createChatChannelSchema,
  editChatMessageSchema,
  inviteChatMembersSchema,
  markChatReadSchema,
  openChatDmSchema,
  patchChatChannelSchema,
  setChatEventsSchema,
  postChatMessageSchema,
  CHAT_STREAM_CURSOR_RE,
  type ChatStreamMessage,
} from "@stubwise/shared";
import { apiError } from "../errors.js";
import {
  ChatAttachmentError,
  deleteStoredObjects,
  downloadableAttachment,
  pruneChatUploads,
  removePendingAttachment,
  signedDownloadUrl,
  uploadChatAttachment,
} from "../chat/attachments.js";
import { refreshViewer } from "./agent-sessions.js";
import { claudeQuestionsOf } from "../chat/claude.js";
import {
  CHAT_CURSOR_MAX,
  answerClaudeQuestion,
  changedSince,
  retryClaudeReply,
  stopClaudeReply,
  ChatError,
  createChannel,
  deleteChannel,
  deleteMessage,
  dismissQuestion,
  editMessage,
  getChannel,
  getMessage,
  getThread,
  inviteMembers,
  joinChannel,
  listChannels,
  listMessages,
  markRead,
  mentionsOf,
  openDm,
  postMessage,
  questionsOf,
  removeMember,
  searchChat,
  setNotifyLevel,
  setThreadFollow,
  signalOf,
  threadsWithNews,
  toggleReaction,
  updateChannel,
  setPublishedEvents,
} from "../chat/service.js";
import { authErrorResponses, errorSchema } from "./shared.js";

// La Chat fra persone (area 4, fette 1 e 2), sotto `/api/chat`. Chi vede, chi
// scrive e chi gestisce lo decide `chat/access.ts`: le rotte dichiarano solo
// `user` e lasciano decidere il servizio (un canale non visibile è 404).

const ACCESS = { kind: "user" } as const;
const idParams = z.object({ id: z.uuid() });
const errors = { ...authErrorResponses, 400: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema };
const STREAM_POLL_MS = 5000;
const STREAM_PING_MS = 25_000;

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ChatError || error instanceof ChatAttachmentError) return apiError(reply, error.status, error.code, error.message);
    throw error;
  }
}

/**
 * Toglie dallo storage gli oggetti di allegati già tolti dal DB, senza mai far
 * fallire la richiesta: la riga non c'è più, quindi l'oggetto non è comunque
 * scaricabile (lo firma solo la rotta di download, che vuole la riga).
 */
async function cleanStorage(app: FastifyInstance, keys: readonly string[], log: FastifyBaseLogger): Promise<void> {
  try {
    await deleteStoredObjects(await app.storage(), keys, (m) => log.warn(m));
  } catch (error) {
    log.warn({ err: error }, "storage degli allegati della Chat non raggiungibile: oggetti da togliere a mano");
  }
}

export async function chatRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  // Letterali PRIMA dei parametrici (la trappola di routing del repo).
  app.get("/threads", { config: { access: ACCESS }, schema: { response: { 200: chatThreadNewsSchema, ...authErrorResponses } } }, async (request) => ({
    items: await threadsWithNews(app.db, request.user!),
  }));
  app.get("/mentions", { config: { access: ACCESS }, schema: { response: { 200: chatMentionListSchema, ...authErrorResponses } } }, async (request) => ({
    items: await mentionsOf(app.db, request.user!),
  }));
  app.get("/signal", { config: { access: ACCESS }, schema: { response: { 200: chatSignalSchema, ...authErrorResponses } } }, async (request) =>
    signalOf(app.db, request.user!),
  );
  // «Da decidere»: le domande della Chat rivolte a chi guarda (fetta 2).
  app.get("/questions", { config: { access: ACCESS }, schema: { response: { 200: chatQuestionListSchema, ...authErrorResponses } } }, async (request) => ({
    items: await questionsOf(app.db, request.user!),
  }));
  app.post(
    "/questions/:id/dismiss",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 204: z.null(), ...errors } } },
    async (request, reply) =>
      handle(reply, async () => {
        await dismissQuestion(app.db, request.user!, request.params.id);
        return reply.code(204).send(null);
      }),
  );
  // «Da decidere»: le domande di @Claude a chi l'ha chiamato (fetta 3).
  app.get(
    "/claude-questions",
    { config: { access: ACCESS }, schema: { response: { 200: chatClaudeQuestionListSchema, ...authErrorResponses } } },
    async (request) => ({ items: await claudeQuestionsOf(app.db, request.user!) }),
  );
  // La ricerca nei canali che chi guarda legge (fetta 2).
  app.get(
    "/search",
    { config: { access: ACCESS }, schema: { querystring: chatSearchQuerySchema, response: { 200: chatSearchResultSchema, ...authErrorResponses } } },
    async (request) => ({
      items: await searchChat(app.db, request.user!, request.query.q, {
        ...(request.query.channelId ? { channelId: request.query.channelId } : {}),
        ...(request.query.authorId ? { authorId: request.query.authorId } : {}),
        ...(request.query.peopleOnly === "true" ? { peopleOnly: true } : {}),
        ...(request.query.withCitations === "true" ? { withCitations: true } : {}),
        ...(request.query.withAttachments === "true" ? { withAttachments: true } : {}),
        ...(request.query.from ? { from: request.query.from } : {}),
        ...(request.query.to ? { to: request.query.to } : {}),
        ...(request.query.limit ? { limit: request.query.limit } : {}),
      }),
    }),
  );
  // Un DM con queste persone: quello che c'è già, o uno nuovo (fetta 2).
  app.post(
    "/dm",
    { config: { access: ACCESS }, schema: { body: openChatDmSchema, response: { 200: chatChannelSchema, ...errors } } },
    async (request, reply) => handle(reply, () => openDm(app.db, request.user!, request.body.personIds)),
  );

  app.get(
    "/channels",
    { config: { access: ACCESS }, schema: { querystring: chatChannelListQuerySchema, response: { 200: chatChannelListSchema, ...authErrorResponses } } },
    async (request) => ({
      items: await listChannels(app.db, request.user!, {
        ...(request.query.projectId ? { projectId: request.query.projectId } : {}),
        ...(request.query.kind ? { kind: request.query.kind } : {}),
        archived: request.query.archived === "true",
      }),
    }),
  );
  app.post(
    "/channels",
    { config: { access: ACCESS }, schema: { body: createChatChannelSchema, response: { 201: chatChannelSchema, ...errors } } },
    async (request, reply) =>
      handle(reply, async () => reply.code(201).send(await createChannel(app.db, request.user!, request.body))),
  );
  app.get(
    "/channels/:id",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 200: chatChannelSchema, ...errors } } },
    async (request, reply) => handle(reply, () => getChannel(app.db, request.user!, request.params.id)),
  );
  app.patch(
    "/channels/:id",
    { config: { access: ACCESS }, schema: { params: idParams, body: patchChatChannelSchema, response: { 200: chatChannelSchema, ...errors } } },
    async (request, reply) => handle(reply, () => updateChannel(app.db, request.user!, request.params.id, request.body)),
  );
  // Gli eventi del progetto che il canale pubblica (fetta 4): l'insieme intero.
  app.put(
    "/channels/:id/events",
    { config: { access: ACCESS }, schema: { params: idParams, body: setChatEventsSchema, response: { 200: chatChannelSchema, ...errors } } },
    async (request, reply) => handle(reply, () => setPublishedEvents(app.db, request.user!, request.params.id, request.body.events)),
  );
  app.delete(
    "/channels/:id",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 204: z.null(), ...errors } } },
    async (request, reply) =>
      handle(reply, async () => {
        const keys = await deleteChannel(app.db, request.user!, request.params.id);
        if (keys.length > 0) await cleanStorage(app, keys, request.log);
        return reply.code(204).send(null);
      }),
  );
  app.post(
    "/channels/:id/join",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 200: chatChannelSchema, ...errors } } },
    async (request, reply) => handle(reply, async () => (await joinChannel(app.db, request.user!, request.params.id, true))!),
  );
  // @Claude (fetta 3): fermare, rifare, rispondere alla sua domanda. Solo chi ha
  // chiamato. Le proposte si decidono con le rotte di sempre
  // (`/api/claude/proposals/:id/confirm|cancel`), che nella Chat ricontrollano
  // anche il canale.
  app.post(
    "/messages/:id/claude/stop",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 200: chatMessageSchema, ...errors } } },
    async (request, reply) => handle(reply, () => stopClaudeReply(app.db, request.user!, request.params.id)),
  );
  app.post(
    "/messages/:id/claude/retry",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 201: chatMessageSchema, ...errors } } },
    async (request, reply) =>
      handle(reply, async () => reply.code(201).send(await retryClaudeReply(app.db, request.user!, request.params.id))),
  );
  app.post(
    "/messages/:id/claude/answer",
    { config: { access: ACCESS }, schema: { params: idParams, body: answerChatClaudeQuestionSchema, response: { 200: chatMessageSchema, ...errors } } },
    async (request, reply) =>
      handle(reply, () =>
        answerClaudeQuestion(app.db, request.user!, request.params.id, {
          questionId: request.body.questionId,
          optionIndex: request.body.optionIndex ?? null,
          text: request.body.text ?? null,
        }),
      ),
  );
  // Uscire: 200 col canale, o 204 se chi esce non lo vede più (un privato, un DM).
  app.delete(
    "/channels/:id/join",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 200: chatChannelSchema, 204: z.null(), ...errors } } },
    async (request, reply) =>
      handle(reply, async () => {
        const view = await joinChannel(app.db, request.user!, request.params.id, false);
        return view ? view : reply.code(204).send(null);
      }),
  );
  // Aggiungere e togliere persone (fetta 2): le regole sono di `channelAccess`.
  app.post(
    "/channels/:id/members",
    { config: { access: ACCESS }, schema: { params: idParams, body: inviteChatMembersSchema, response: { 200: chatChannelSchema, ...errors } } },
    async (request, reply) => handle(reply, () => inviteMembers(app.db, request.user!, request.params.id, request.body.personIds)),
  );
  app.delete(
    "/channels/:id/members/:userId",
    {
      config: { access: ACCESS },
      schema: {
        params: z.object({ id: z.uuid(), userId: z.uuid() }),
        response: { 200: chatChannelSchema, 204: z.null(), ...errors },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const view = await removeMember(app.db, request.user!, request.params.id, request.params.userId);
        return view ? view : reply.code(204).send(null);
      }),
  );
  app.get(
    "/channels/:id/messages",
    {
      config: { access: ACCESS },
      schema: { params: idParams, querystring: chatMessagePageQuerySchema, response: { 200: chatMessagePageSchema, ...errors } },
    },
    async (request, reply) =>
      handle(reply, () =>
        listMessages(app.db, request.user!, request.params.id, {
          ...(request.query.before ? { before: request.query.before } : {}),
          ...(request.query.limit ? { limit: request.query.limit } : {}),
        }),
      ),
  );
  app.post(
    "/channels/:id/messages",
    { config: { access: ACCESS }, schema: { params: idParams, body: postChatMessageSchema, response: { 201: chatMessageSchema, ...errors } } },
    async (request, reply) =>
      handle(reply, async () =>
        reply.code(201).send(
          await postMessage(app.db, request.user!, request.params.id, {
            text: request.body.text,
            ...(request.body.threadRootId ? { threadRootId: request.body.threadRootId } : {}),
            ...(request.body.alsoInChannel ? { alsoInChannel: true } : {}),
            ...(request.body.asksReply ? { asksReply: true } : {}),
            ...(request.body.citations ? { citations: request.body.citations } : {}),
            ...(request.body.attachmentIds ? { attachmentIds: request.body.attachmentIds } : {}),
          }),
        ),
      ),
  );
  // Gli allegati (fetta 4). Il caricamento: multipart, un file, al più 25 MB;
  // nasce in sospeso, lo lega un messaggio di chi l'ha caricato.
  app.post(
    "/channels/:id/attachments",
    {
      config: { access: ACCESS },
      schema: { params: idParams, response: { 201: chatAttachmentSchema, 413: errorSchema, ...errors } },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const storage = await app.storage();
        if (!storage) return apiError(reply, 400, "storage_not_configured", "Object storage is not configured");
        const tooLarge = () => apiError(reply, 413, "file_too_large", "File exceeds the 25 MB limit");
        let part;
        try {
          part = await request.file({ limits: { fileSize: CHAT_ATTACHMENT_MAX_BYTES, files: 1 } });
        } catch (error) {
          if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return tooLarge();
          throw error;
        }
        if (!part) return apiError(reply, 400, "file_required", "A file is required");
        let body: Buffer;
        try {
          body = await part.toBuffer();
        } catch (error) {
          if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return tooLarge();
          throw error;
        }
        if (part.file.truncated || body.length > CHAT_ATTACHMENT_MAX_BYTES) return tooLarge();
        const created = await uploadChatAttachment(app.db, storage, request.user!, request.params.id, {
          filename: part.filename,
          mimeType: part.mimetype,
          body,
        });
        // Igiene: chi carica pota anche i sospesi scaduti ([DECIDE] 3), senza aspettare.
        void pruneChatUploads(app.db, storage, (m) => request.log.warn(m)).catch((e: unknown) => request.log.warn(e, "potatura allegati"));
        return reply.code(201).send(created);
      }),
  );
  app.post(
    "/channels/:id/read",
    { config: { access: ACCESS }, schema: { params: idParams, body: markChatReadSchema, response: { 204: z.null(), ...errors } } },
    async (request, reply) =>
      handle(reply, async () => {
        await markRead(app.db, request.user!, request.params.id, {
          ...(request.body.threadRootId ? { threadRootId: request.body.threadRootId } : {}),
          ...(request.body.at ? { at: request.body.at } : {}),
        });
        return reply.code(204).send(null);
      }),
  );
  app.put(
    "/channels/:id/pref",
    { config: { access: ACCESS }, schema: { params: idParams, body: chatChannelPrefSchema, response: { 200: chatChannelSchema, ...errors } } },
    async (request, reply) => handle(reply, () => setNotifyLevel(app.db, request.user!, request.params.id, request.body.level)),
  );

  // Il download: 302 verso l'URL firmato (`Content-Disposition: attachment`),
  // solo per chi legge il canale. La seconda richiesta va allo storage senza
  // header: basta la firma, che scade in pochi minuti.
  app.get(
    "/attachments/:id/download",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 302: z.null(), ...errors } } },
    async (request, reply) => {
      const row = await downloadableAttachment(app.db, request.user!, request.params.id);
      if (!row) return apiError(reply, 404, "not_found", "Not found");
      const storage = await app.storage();
      if (!storage) return apiError(reply, 400, "storage_not_configured", "Object storage is not configured");
      return reply.redirect(await signedDownloadUrl(storage, row), 302);
    },
  );
  // Togliere un allegato in sospeso (prima di mandare): solo chi l'ha caricato.
  app.delete(
    "/attachments/:id",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 204: z.null(), ...errors } } },
    async (request, reply) => {
      const key = await removePendingAttachment(app.db, request.user!, request.params.id);
      if (key === null) return apiError(reply, 404, "not_found", "Not found");
      await cleanStorage(app, [key], request.log);
      return reply.code(204).send(null);
    },
  );
  app.get(
    "/messages/:id",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 200: chatMessageSchema, ...errors } } },
    async (request, reply) => handle(reply, () => getMessage(app.db, request.user!, request.params.id)),
  );
  app.get(
    "/messages/:id/thread",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 200: chatThreadSchema, ...errors } } },
    async (request, reply) => handle(reply, () => getThread(app.db, request.user!, request.params.id)),
  );
  app.patch(
    "/messages/:id",
    { config: { access: ACCESS }, schema: { params: idParams, body: editChatMessageSchema, response: { 200: chatMessageSchema, ...errors } } },
    async (request, reply) =>
      handle(reply, async () => {
        const { message, removedKeys } = await editMessage(
          app.db,
          request.user!,
          request.params.id,
          request.body.text,
          request.body.citations ?? [],
          request.body.attachmentIds,
        );
        // Gli allegati tolti: lo storage dopo il commit, senza bloccare la risposta.
        if (removedKeys.length > 0) void cleanStorage(app, removedKeys, request.log);
        return message;
      }),
  );
  app.delete(
    "/messages/:id",
    { config: { access: ACCESS }, schema: { params: idParams, response: { 204: z.null(), ...errors } } },
    async (request, reply) =>
      handle(reply, async () => {
        const keys = await deleteMessage(app.db, request.user!, request.params.id);
        if (keys.length > 0) await cleanStorage(app, keys, request.log);
        return reply.code(204).send(null);
      }),
  );
  app.post(
    "/messages/:id/reactions/toggle",
    { config: { access: ACCESS }, schema: { params: idParams, body: chatReactionBodySchema, response: { 200: chatMessageSchema, ...errors } } },
    async (request, reply) => handle(reply, () => toggleReaction(app.db, request.user!, request.params.id, request.body.emoji)),
  );
  app.put(
    "/messages/:id/follow",
    { config: { access: ACCESS }, schema: { params: idParams, body: chatThreadFollowSchema, response: { 200: chatMessageSchema, ...errors } } },
    async (request, reply) => handle(reply, () => setThreadFollow(app.db, request.user!, request.params.id, request.body.following)),
  );

  /**
   * Lo stream SSE di un canale: i messaggi cambiati dopo il cursore (nuovi,
   * modificati, eliminati, reazioni, e le radici che hanno avuto risposte) e
   * la vista del canale. Chi guarda e la visibilità si RILEGGONO a ogni giro:
   * se il canale non è più visibile, lo stream si chiude.
   */
  app.get(
    "/channels/:id/stream",
    { config: { access: ACCESS }, schema: { params: idParams, querystring: z.object({ after: z.string().regex(CHAT_STREAM_CURSOR_RE).optional() }) } },
    async (request, reply) => {
      const id = request.params.id;
      // Un cursore oltre il `bigint` non è un cursore: 400, non un giro infinito.
      if (request.query.after !== undefined && BigInt(request.query.after) > CHAT_CURSOR_MAX) {
        return apiError(reply, 400, "invalid_cursor", "Invalid cursor");
      }
      let viewer: Parameters<typeof getChannel>[1] = request.user!;
      let first;
      try {
        first = await getChannel(app.db, viewer, id);
      } catch (error) {
        if (error instanceof ChatError) return apiError(reply, error.status, error.code, error.message);
        throw error;
      }
      // Lo stream porta i messaggi: solo a chi LEGGE il canale (chi gestisce un privato senza esserne membro no, D2).
      if (!first.canRead) return apiError(reply, 404, "not_found", "Not found");
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      let closed = false;
      let cursor = request.query.after;
      // Ciò che è già partito (id → `updated_at` in µs): la finestra di
      // sovrapposizione rilegge, questa mappa non rimanda.
      const seen = new Map<string, string>();
      // Il frame `channel` parte solo se la vista è cambiata.
      let lastChannel = "";
      let reading = false;
      let dirty = false;
      const timers: NodeJS.Timeout[] = [];
      const send = (m: ChatStreamMessage) => {
        if (!closed) reply.raw.write(`data: ${JSON.stringify(m)}\n\n`);
      };
      let unsubscribe: () => void = () => undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t);
        unsubscribe();
        reply.raw.end();
      };
      const pump = async () => {
        if (closed) return;
        if (reading) {
          dirty = true;
          return;
        }
        reading = true;
        try {
          do {
            dirty = false;
            const fresh = await refreshViewer(app.db, viewer.id);
            if (!fresh) return close();
            viewer = fresh;
            const changed = await changedSince(app.db, viewer, id, cursor, seen);
            if (!changed) return close();
            cursor = changed.cursor ?? cursor;
            if (changed.messages.length > 0) send({ type: "messages", messages: changed.messages, cursor: changed.cursor });
            const channel = await getChannel(app.db, viewer, id);
            const serialized = JSON.stringify(channel);
            if (serialized !== lastChannel) {
              lastChannel = serialized;
              send({ type: "channel", channel });
            }
          } while (dirty && !closed);
        } catch (error) {
          if (error instanceof ChatError) return close();
          request.log.warn({ err: error }, "chat stream: lettura fallita");
        } finally {
          reading = false;
        }
      };
      reply.raw.on("close", close);
      lastChannel = JSON.stringify(first);
      send({ type: "channel", channel: first });
      unsubscribe = app.chatBus.subscribe(id, () => void pump());
      timers.push(
        setInterval(() => void pump(), STREAM_POLL_MS),
        setInterval(() => {
          if (!closed) reply.raw.write(": ping\n\n");
        }, STREAM_PING_MS),
      );
      await pump();
    },
  );
}
