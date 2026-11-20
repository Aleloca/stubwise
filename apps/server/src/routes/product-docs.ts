import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  addProductCommentSchema,
  productCommentViewSchema,
  productCommentsSchema,
  productMentionCandidatesSchema,
  productPageViewSchema,
  productRevisionViewSchema,
  productSearchResultsSchema,
  productExportPageSchema,
  productPresenceBeatResultSchema,
  productPresenceBeatSchema,
  productExportSpaceSchema,
  productExportTooLargeSchema,
  productMarkViewSchema,
  productOpenQuestionSchema,
  answerProductQuestionSchema,
  PRODUCT_EXPORT_PAGES_MAX,
  productSpaceSchema,
  saveProductBlocksSchema,
} from "@stubwise/shared";
import { routePermissions, type RouteAccess } from "../auth/access.js";
import { fromParam, fromProductComment, fromProductMark, fromProductPage, fromProductRevision } from "../auth/project-resolvers.js";
import { ProductUndoBlockedError, acceptProductMark, listProductMarks, undoProductMark, undoProductRevision, withClaudeFields } from "../services/product-claude.js";
import { apiError } from "../errors.js";
import {
  ProductDocsError,
  createProductPage,
  deleteProductPage,
  productPageByCode,
  productSpace,
  updateProductPage,
} from "../services/product-docs.js";
import {
  PRODUCT_IMAGE_MAX_BYTES,
  ProductSectionBusyError,
  ProductStaleError,
  followProductPage,
  imageMimeOf,
  listProductRevisions,
  productImageKey,
  productImageOf,
  productPageProject,
  recordProductImage,
  saveProductBlocks,
} from "../services/product-docs-ops.js";
import { searchProductPages } from "../services/product-search.js";
import { ProductLiveError } from "../services/product-live.js";
import { PRODUCT_TOP_SECTION } from "@stubwise/shared";

/** Review di F4 (M9): oltre questo, un client che non legge si chiude (riapre e riceve `state`). */
const PRODUCT_LIVE_MAX_BUFFER = 1_000_000;
import { visiblePersonIds } from "../services/people-visibility.js";
import { productPages } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { exportProductPage, exportProductSpace, ProductExportTooLarge } from "../services/product-export.js";
import { addProductComment, listProductComments, productMentionCandidates, setProductCommentResolved } from "../services/product-comments.js";
import { ProductQuestionConflictError, answerProductQuestion, listOpenProductQuestions } from "../services/product-questions.js";
import { StorageObjectNotFound } from "../storage/errors.js";
import { removeOrRecordOrphan } from "../storage/orphans.js";
import { authErrorResponses, errorSchema } from "./shared.js";

// Area 11, F1 — lo spazio Product, sotto `/api`. Le regole stanno nei servizi
// (`services/product-docs.ts`); qui le rotte, con l'accesso dichiarato:
// `docs.view` per leggere, `docs.edit` per scrivere, invisibile = 404.

const SPACE_VIEW: RouteAccess = { kind: "project", permission: "docs.view", project: fromParam("projectId") };
const SPACE_EDIT: RouteAccess = { kind: "project", permission: "docs.edit", project: fromParam("projectId") };
const PAGE_EDIT: RouteAccess = { kind: "project", permission: "docs.edit", project: fromProductPage("id") };
const PAGE_VIEW: RouteAccess = { kind: "project", permission: "docs.view", project: fromProductPage("id") };
const COMMENT_EDIT: RouteAccess = { kind: "project", permission: "docs.edit", project: fromProductComment("id") };
const MARK_EDIT: RouteAccess = { kind: "project", permission: "docs.edit", project: fromProductMark("id") };
const REVISION_EDIT: RouteAccess = { kind: "project", permission: "docs.edit", project: fromProductRevision("id") };

/** F5: un «Undo» spento (409 col motivo e chi), o una sezione presa (come le ops). */
const undoConflictSchema = z.object({ code: z.string(), message: z.string(), byId: z.uuid().nullable().optional(), byName: z.string().nullable().optional(), sectionId: z.string().optional(), by: z.object({ id: z.uuid(), name: z.string().nullable() }).optional() });

async function handleUndo<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ProductUndoBlockedError || error instanceof ProductQuestionConflictError) return reply.code(409).send({ code: error.code, message: error.message, byId: error.by.id, byName: error.by.name });
    if (error instanceof ProductSectionBusyError) return reply.code(409).send({ code: error.code, message: error.message, sectionId: error.sectionId, by: error.by });
    if (error instanceof ProductDocsError) return apiError(reply, error.status, error.code, error.message);
    throw error;
  }
}

const projectParams = z.object({ projectId: z.uuid() });
const pageParams = z.object({ id: z.uuid() });
const title = z.string().max(200);

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ProductDocsError) return apiError(reply, error.status, error.code, error.message);
    throw error;
  }
}

/** Un id di blocco nuovo, come il prototipo (`makeBlockId`). */
const newBlockId = () => `blk-${randomUUID()}`;

export async function productDocsRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/projects/:projectId/product",
    { config: { access: SPACE_VIEW }, schema: { params: projectParams, response: { 200: productSpaceSchema, 404: errorSchema, ...authErrorResponses } } },
    async (request, reply) => handle(reply, () => productSpace(app.db, request.params.projectId, routePermissions(request))),
  );

  app.post(
    "/projects/:projectId/product/pages",
    {
      config: { access: SPACE_EDIT },
      schema: {
        params: projectParams,
        body: z.object({ title, parentId: z.uuid().nullable().optional(), index: z.number().int().min(0).optional() }).strict(),
        response: { 201: z.object({ id: z.uuid(), code: z.string() }), 400: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const created = await createProductPage(app.db, request.user!, request.params.projectId, request.body, newBlockId);
        return reply.code(201).send(created);
      }),
  );

  // Il codice: la rotta è `user` perché la regola del 403/404 la decide il
  // servizio (un codice in un progetto visibile senza `docs.view` è 403 anche
  // se la pagina non c'è).
  app.get(
    "/product-pages/by-code/:code",
    {
      config: { access: { kind: "user" } },
      schema: { params: z.object({ code: z.string().min(1).max(40) }), response: { ...authErrorResponses, 200: productPageViewSchema, 404: errorSchema } },
    },
    async (request, reply) => handle(reply, () => productPageByCode(app.db, request.user!, request.params.code)),
  );

  app.patch(
    "/product-pages/:id",
    {
      config: { access: PAGE_EDIT },
      schema: {
        params: pageParams,
        body: z
          .object({ title: title.optional(), move: z.object({ parentId: z.uuid().nullable(), index: z.number().int().min(0) }).strict().optional() })
          .strict()
          .refine((b) => b.title !== undefined || b.move !== undefined, "title or move"),
        response: { 204: z.null(), 400: errorSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const written = await updateProductPage(app.db, request.user!, request.params.id, request.body);
        // F4: agli stream della pagina, dopo il commit, le revisioni che QUESTA scrittura ha fatto
        // (review di F4, I5: mai il seq riletto, che può essere di un'altra scrittura).
        for (const r of written) {
          void app.productLive
            .revision({ pageId: request.params.id, seq: r.seq, kind: r.kind, actorId: request.user!.id, sessionId: null, title: r.title, parentId: r.parentId })
            .catch((error: unknown) => request.log.warn({ err: error }, "canale dal vivo: cambio della pagina non consegnato"));
        }
        return reply.code(204).send(null);
      }),
  );

  app.delete(
    "/product-pages/:id",
    { config: { access: PAGE_EDIT }, schema: { params: pageParams, response: { 204: z.null(), 404: errorSchema, 409: errorSchema, ...authErrorResponses } } },
    async (request, reply) =>
      handle(reply, async () => {
        const { storageKeys } = await deleteProductPage(app.db, request.params.id);
        // F4: chi la guarda dal vivo riceve `gone`.
        app.productLive.gone(request.params.id);
        // Gli oggetti delle immagini DOPO il commit (review di F1, I2): uno storage
        // che rifiuta lascia la chiave in `storage_orphans`, e la pulizia oraria la ritenta.
        if (storageKeys.length > 0) {
          const storage = await app.storage();
          if (storage) for (const key of storageKeys) await removeOrRecordOrphan(app.db, storage, key, "product page deleted");
          else request.log.warn(`[product] storage non configurato: ${storageKeys.length} immagini restano da togliere`);
        }
        return reply.code(204).send(null);
      }),
  );

  // --- Task 4: scrivere a operazioni, la cronologia, Segui, le immagini ---

  app.post(
    "/product-pages/:id/ops",
    {
      config: { access: PAGE_EDIT },
      schema: {
        params: pageParams,
        body: saveProductBlocksSchema,
        response: { 200: z.object({ seq: z.number().int(), revisionId: z.uuid().nullable() }), 409: z.object({
          code: z.string(),
          message: z.string(),
          revisions: z.array(productRevisionViewSchema).optional(),
          // F4: `section_busy` dice la sezione e chi la tiene (`productSectionBusySchema`).
          sectionId: z.string().optional(),
          by: z.object({ id: z.uuid(), name: z.string().nullable() }).optional(),
        }), 422: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      try {
        const saved = await saveProductBlocks(app.db, request.user!, request.params.id, request.body);
        // F4: agli stream della pagina, dopo il commit, CON le operazioni (chi è al seq di prima le applica).
        void app.productLive
          .revision({ pageId: request.params.id, seq: saved.seq, kind: "edit", actorId: request.user!.id, sessionId: request.body.sessionId, ops: request.body.ops })
          .catch((error: unknown) => request.log.warn({ err: error }, "canale dal vivo: revisione non consegnata"));
        return saved;
      } catch (error) {
        if (error instanceof ProductStaleError) return reply.code(409).send({ code: error.code, message: error.message, revisions: error.revisions });
        if (error instanceof ProductSectionBusyError) return reply.code(409).send({ code: error.code, message: error.message, sectionId: error.sectionId, by: error.by });
        if (error instanceof ProductDocsError) return apiError(reply, error.status, error.code, error.message);
        throw error;
      }
    },
  );

  app.get(
    "/product-pages/:id/revisions",
    {
      config: { access: PAGE_VIEW },
      schema: { params: pageParams, querystring: z.object({ before: z.coerce.number().int().min(1).optional() }), response: { 200: z.array(productRevisionViewSchema), ...authErrorResponses } },
    },
    async (request) => withClaudeFields(app.db, request.user!, request.params.id, await listProductRevisions(app.db, request.user!, request.params.id, request.query.before)),
  );

  // --- F5: i segni di Claude, «Looks good», «Undo» e «Undo all» ---

  app.get(
    "/product-pages/:id/marks",
    { config: { access: PAGE_VIEW }, schema: { params: pageParams, response: { 200: z.array(productMarkViewSchema), 404: errorSchema, ...authErrorResponses } } },
    async (request, reply) => handle(reply, () => listProductMarks(app.db, request.user!, request.params.id)),
  );

  app.post(
    "/product-marks/:id/looks-good",
    { config: { access: MARK_EDIT }, schema: { params: pageParams, response: { 204: z.null(), 404: errorSchema, 409: undoConflictSchema, ...authErrorResponses } } },
    async (request, reply) =>
      handleUndo(reply, async () => {
        await acceptProductMark(app.db, request.user!, request.params.id);
        return reply.code(204).send(null);
      }),
  );

  const undoResult = z.object({ seq: z.number().int(), revisionId: z.uuid().nullable() });
  app.post(
    "/product-marks/:id/undo",
    { config: { access: MARK_EDIT }, schema: { params: pageParams, response: { 200: undoResult, 404: errorSchema, 409: undoConflictSchema, ...authErrorResponses } } },
    async (request, reply) => handleUndo(reply, () => undoProductMark(app.db, request.user!, request.params.id)),
  );

  app.post(
    "/product-revisions/:id/undo-all",
    { config: { access: REVISION_EDIT }, schema: { params: pageParams, response: { 200: undoResult, 404: errorSchema, 409: undoConflictSchema, ...authErrorResponses } } },
    async (request, reply) => handleUndo(reply, () => undoProductRevision(app.db, request.user!, request.params.id)),
  );

  // Seguire una pagina: chi la legge (`docs.view`).
  for (const [method, on] of [["put", true], ["delete", false]] as const) {
    app[method](
      "/product-pages/:id/follow",
      { config: { access: PAGE_VIEW }, schema: { params: pageParams, response: { 204: z.null(), ...authErrorResponses } } },
      async (request, reply) => {
        await followProductPage(app.db, request.user!, request.params.id, on);
        return reply.code(204).send(null);
      },
    );
  }

  // Le immagini (D-3 = a): multipart, un file, 5 MB, il tipo dai BYTE, mai SVG.
  app.post(
    "/product-pages/:id/images",
    {
      config: { access: PAGE_EDIT, rateLimit: { max: 60, timeWindow: "1 minute", hook: "preHandler", keyGenerator: (request: FastifyRequest) => request.user?.id ?? request.ip } },
      schema: { params: pageParams, response: { 201: z.object({ id: z.uuid(), ref: z.string() }), 400: errorSchema, 413: errorSchema, 422: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const page = await productPageProject(app.db, request.params.id);
      if (!page) return apiError(reply, 404, "not_found", "Not found");
      const storage = await app.storage();
      if (!storage) return apiError(reply, 400, "storage_not_configured", "Object storage is not configured");
      let part;
      try {
        part = await request.file({ limits: { fileSize: PRODUCT_IMAGE_MAX_BYTES, files: 1, fields: 0, parts: 1 } });
      } catch (error) {
        if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return apiError(reply, 413, "file_too_large", "An image is at most 5 MB");
        return apiError(reply, 400, "invalid_multipart", "Send one image and nothing else");
      }
      if (!part) return apiError(reply, 400, "file_required", "An image is required");
      const bytes = await part.toBuffer().catch(() => null);
      if (!bytes || part.file.truncated) return apiError(reply, 413, "file_too_large", "An image is at most 5 MB");
      const mime = imageMimeOf(bytes);
      if (!mime) return apiError(reply, 422, "invalid_image", "PNG, JPEG, GIF or WebP only");
      const key = productImageKey(page.projectId, page.id);
      await storage.putObject(key, bytes, mime);
      const created = await recordProductImage(app.db, request.user!, page, { storageKey: key, mime, sizeBytes: bytes.length });
      return reply.code(201).send(created);
    },
  );

  // L'immagine si apre dalla rotta, coi permessi della pagina, coi BYTE (al più
  // 5 MB, il tipo verificato dai byte al caricamento, mai SVG). Non un 302
  // verso lo storage: lo storage d'istanza ha un'altra origine, e né il proxy
  // del main del desktop (`redirect: "manual"`) né una `fetch` col cookie del
  // web (CORS) seguono quel redirect (review di R11-1, 46 e 94).
  app.get(
    "/product-pages/:id/images/:imageId",
    {
      // Review di F2 (M7): fino a 5 MB in memoria per richiesta, quindi un tetto per persona.
      config: { access: PAGE_VIEW, rateLimit: { max: 600, timeWindow: "1 minute", hook: "preHandler", keyGenerator: (request: FastifyRequest) => request.user?.id ?? request.ip } },
      schema: { params: z.object({ id: z.uuid(), imageId: z.uuid() }), response: { 304: z.null(), 400: errorSchema, 404: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const image = await productImageOf(app.db, request.params.id, request.params.imageId);
      if (!image) return apiError(reply, 404, "not_found", "Not found");
      // Review di F2 (M6): un'immagine non cambia mai sotto il suo id, quindi l'ETag
      // è l'id; `no-cache` fa rivalidare OGNI volta, e la rivalidazione passa dal
      // controllo dei permessi qui sopra (chi non vede più la pagina ha 404, non 304).
      const etag = `"${image.id}"`;
      reply.header("etag", etag).header("cache-control", "private, no-cache").header("vary", "Cookie");
      if (request.headers["if-none-match"] === etag) return reply.code(304).send(null);
      const storage = await app.storage();
      if (!storage) return apiError(reply, 400, "storage_not_configured", "Object storage is not configured");
      let bytes: Buffer;
      try {
        bytes = await storage.getObjectBytes(image.storageKey, PRODUCT_IMAGE_MAX_BYTES);
      } catch (error) {
        if (error instanceof StorageObjectNotFound) return apiError(reply, 404, "not_found", "Not found");
        throw error;
      }
      return reply
        .header("content-type", image.mime)
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", "inline")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .send(bytes as never);
    },
  );

  // --- F4: il canale dal vivo e il battito ---

  app.get(
    "/product-pages/:id/live",
    { config: { access: PAGE_VIEW }, schema: { params: pageParams, response: { 404: errorSchema, 429: errorSchema, ...authErrorResponses } } },
    async (request, reply) => {
      const [page] = await app.db.select({ projectId: productPages.projectId, seq: productPages.revSeq }).from(productPages).where(eq(productPages.id, request.params.id));
      if (!page) return apiError(reply, 404, "not_found", "Not found");
      // Review di F4 (I2, M9, M10): la chiusura si ascolta da SUBITO (un client che se ne
      // va durante l'apertura non lascia uno stream orfano nei tetti); prima dell'hijack
      // non si scrive né si chiude la risposta; un client lento oltre una soglia si chiude.
      let closed = false;
      let hijacked = false;
      let unsubscribe: () => void = () => undefined;
      const timers: NodeJS.Timeout[] = [];
      const close = () => {
        if (closed) return;
        closed = true;
        for (const timer of timers) clearInterval(timer);
        unsubscribe();
        if (hijacked) reply.raw.end();
      };
      reply.raw.on("close", close);
      const pending: Record<string, unknown>[] = [];
      const write = (frame: Record<string, unknown>) => {
        if (closed) return;
        if (!hijacked) {
          pending.push(frame);
          return;
        }
        const ok = reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
        if (!ok && reply.raw.writableLength > PRODUCT_LIVE_MAX_BUFFER) close();
      };
      try {
        unsubscribe = await app.productLive.open({ pageId: request.params.id, projectId: page.projectId, userId: request.user!.id, seq: page.seq, send: write, close });
      } catch (error) {
        if (error instanceof ProductLiveError) return apiError(reply, error.status as 404, error.code, error.message);
        throw error;
      }
      // Se ne è andato mentre si apriva: il posto si libera, e niente stream.
      if (closed || request.raw.destroyed || reply.raw.destroyed) {
        unsubscribe();
        closed = true;
        return reply;
      }
      reply.hijack();
      hijacked = true;
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      for (const frame of pending.splice(0)) write(frame);
      timers.push(
        setInterval(() => {
          if (!closed) reply.raw.write(": ping\n\n");
        }, 25_000),
      );
    },
  );

  app.post(
    "/product-pages/:id/live/presence",
    {
      // Review di F4 (I4): ogni battito legge permessi e persone e manda alla pagina: un tetto per persona.
      config: { access: PAGE_VIEW, rateLimit: { max: 120, timeWindow: "1 minute", hook: "preHandler", keyGenerator: (request: FastifyRequest) => request.user?.id ?? request.ip } },
      schema: { params: pageParams, body: productPresenceBeatSchema, response: { 200: productPresenceBeatResultSchema, 422: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) => {
      const sectionId = request.body.sectionId;
      if (typeof sectionId === "string") {
        // Con una sezione il battito PRENDE (scrive): serve `docs.edit`.
        if (!routePermissions(request).has("docs.edit")) return apiError(reply, 403, "forbidden", "Missing permission");
        // Una sezione VERA della pagina: un titolo che c'è, o quella in cima (I4).
        if (sectionId !== PRODUCT_TOP_SECTION) {
          const [page] = await app.db.select({ blocks: productPages.blocks }).from(productPages).where(eq(productPages.id, request.params.id));
          const isHeading = Array.isArray(page?.blocks) && (page!.blocks as { id?: unknown; type?: unknown }[]).some((b) => b?.id === sectionId && b?.type === "heading");
          if (!isHeading) return apiError(reply, 422, "invalid_section", "Not a section of this page");
        }
      }
      const people = await visiblePersonIds(app.db, request.user!);
      return app.productLive.beat({
        pageId: request.params.id,
        userId: request.user!.id,
        viewerSees: (id) => people === "all" || people.includes(id),
        ...(request.body.sessionId !== undefined ? { sessionId: request.body.sessionId } : {}),
        ...(request.body.cursor !== undefined ? { cursor: request.body.cursor } : {}),
        ...(sectionId !== undefined ? { sectionId } : {}),
      });
    },
  );

  // --- F3: la ricerca «In Product» dello spazio (ibrida: significato e testo) ---

  app.get(
    "/projects/:projectId/product/search",
    { config: { access: SPACE_VIEW }, schema: { params: projectParams, querystring: z.object({ q: z.string().min(1).max(200) }), response: { 200: productSearchResultsSchema, 400: errorSchema, ...authErrorResponses } } },
    async (request, reply) => {
      if (request.query.q.trim() === "") return apiError(reply, 400, "empty_query", "Search query must not be empty");
      const { items, hasMore } = await searchProductPages(app.db, app.embeddingClient, request.user!, request.query.q, { projectId: request.params.projectId, log: request.log });
      return { items, hasMore };
    },
  );

  // --- F3: l'esportazione (il file lo compone il client, D-4 = a) ---

  app.get(
    "/product-pages/:id/export",
    { config: { access: PAGE_VIEW }, schema: { params: pageParams, response: { 200: productExportPageSchema, 404: errorSchema, ...authErrorResponses } } },
    async (request, reply) => handle(reply, () => exportProductPage(app.db, request.user!, request.params.id)),
  );

  app.get(
    "/projects/:projectId/product/export",
    { config: { access: SPACE_VIEW }, schema: { params: projectParams, response: { 200: productExportSpaceSchema, 404: errorSchema, 413: productExportTooLargeSchema, ...authErrorResponses } } },
    async (request, reply) => {
      try {
        return await exportProductSpace(app.db, request.user!, request.params.projectId);
      } catch (error) {
        if (error instanceof ProductExportTooLarge) return reply.code(413).send({ code: "too_many_pages", message: error.message, count: error.count, max: PRODUCT_EXPORT_PAGES_MAX });
        if (error instanceof ProductDocsError) return apiError(reply, error.status, error.code, error.message);
        throw error;
      }
    },
  );

  // --- F2: i commenti, la risoluzione, i candidati alle menzioni ---

  app.get(
    "/product-pages/:id/comments",
    { config: { access: PAGE_VIEW }, schema: { params: pageParams, response: { 200: productCommentsSchema, 404: errorSchema, ...authErrorResponses } } },
    async (request, reply) => handle(reply, () => listProductComments(app.db, request.user!, request.params.id)),
  );

  app.post(
    "/product-pages/:id/comments",
    {
      config: { access: PAGE_EDIT },
      schema: { params: pageParams, body: addProductCommentSchema, response: { 201: productCommentViewSchema, 404: errorSchema, 422: errorSchema, ...authErrorResponses } },
    },
    async (request, reply) =>
      handle(reply, async () => {
        const added = await addProductComment(app.db, request.user!, request.params.id, request.body);
        return reply.code(201).send(added.view);
      }),
  );

  for (const [action, resolved] of [["resolve", true], ["reopen", false]] as const) {
    app.post(
      `/product-comments/:id/${action}`,
      { config: { access: COMMENT_EDIT }, schema: { params: pageParams, response: { 204: z.null(), 404: errorSchema, 422: errorSchema, ...authErrorResponses } } },
      async (request, reply) =>
        handle(reply, async () => {
          await setProductCommentResolved(app.db, request.user!, request.params.id, resolved);
          return reply.code(204).send(null);
        }),
    );
  }

  // --- F5: le domande di Claude (rispondere chiede `docs.edit`, una risposta sola) ---

  app.post(
    "/product-comments/:id/answer",
    {
      config: { access: COMMENT_EDIT },
      schema: {
        params: pageParams,
        body: answerProductQuestionSchema,
        response: { 200: z.object({ revisionId: z.uuid().nullable(), seq: z.number().int().nullable() }), 404: errorSchema, 409: undoConflictSchema, 422: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => handleUndo(reply, () => answerProductQuestion(app.db, request.user!, request.params.id, request.body.option)),
  );

  app.get(
    "/me/product-questions",
    { config: { access: { kind: "user" } }, schema: { querystring: z.object({ pageId: z.uuid().optional() }), response: { 200: z.array(productOpenQuestionSchema), ...authErrorResponses } } },
    async (request) => listOpenProductQuestions(app.db, request.user!, request.query.pageId),
  );

  app.get(
    "/projects/:projectId/product/mention-candidates",
    { config: { access: SPACE_VIEW }, schema: { params: projectParams, querystring: z.object({ q: z.string().max(100).default("") }), response: { 200: productMentionCandidatesSchema, ...authErrorResponses } } },
    async (request) => productMentionCandidates(app.db, request.user!, request.params.projectId, request.query.q),
  );
}
