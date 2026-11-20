import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { productPageViewSchema, productRevisionViewSchema, productSpaceSchema, saveProductBlocksSchema } from "@stubwise/shared";
import { routePermissions, type RouteAccess } from "../auth/access.js";
import { fromParam, fromProductPage } from "../auth/project-resolvers.js";
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
import { authErrorResponses, errorSchema } from "./shared.js";

// Area 11, F1 — lo spazio Product, sotto `/api`. Le regole stanno nei servizi
// (`services/product-docs.ts`); qui le rotte, con l'accesso dichiarato:
// `docs.view` per leggere, `docs.edit` per scrivere, invisibile = 404.

const SPACE_VIEW: RouteAccess = { kind: "project", permission: "docs.view", project: fromParam("projectId") };
const SPACE_EDIT: RouteAccess = { kind: "project", permission: "docs.edit", project: fromParam("projectId") };
const PAGE_EDIT: RouteAccess = { kind: "project", permission: "docs.edit", project: fromProductPage("id") };
const PAGE_VIEW: RouteAccess = { kind: "project", permission: "docs.view", project: fromProductPage("id") };

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
        await updateProductPage(app.db, request.user!, request.params.id, request.body);
        return reply.code(204).send(null);
      }),
  );

  app.delete(
    "/product-pages/:id",
    { config: { access: PAGE_EDIT }, schema: { params: pageParams, response: { 204: z.null(), 404: errorSchema, 409: errorSchema, ...authErrorResponses } } },
    async (request, reply) =>
      handle(reply, async () => {
        await deleteProductPage(app.db, request.params.id);
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
        response: { 200: z.object({ seq: z.number().int(), revisionId: z.uuid().nullable() }), 409: z.object({ code: z.string(), message: z.string(), revisions: z.array(productRevisionViewSchema).optional() }), 422: errorSchema, 404: errorSchema, ...authErrorResponses },
      },
    },
    async (request, reply) => {
      try {
        return await saveProductBlocks(app.db, request.user!, request.params.id, request.body);
      } catch (error) {
        if (error instanceof ProductStaleError) return reply.code(409).send({ code: error.code, message: error.message, revisions: error.revisions });
        if (error instanceof ProductDocsError) return apiError(reply, error.status, error.code, error.message);
        throw error;
      }
    },
  );

  app.get(
    "/product-pages/:id/revisions",
    { config: { access: PAGE_VIEW }, schema: { params: pageParams, response: { 200: z.array(productRevisionViewSchema), ...authErrorResponses } } },
    async (request) => listProductRevisions(app.db, request.user!, request.params.id),
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

  // L'immagine si apre dalla rotta, coi permessi della pagina: un URL firmato breve.
  app.get(
    "/product-pages/:id/images/:imageId",
    { config: { access: PAGE_VIEW }, schema: { params: z.object({ id: z.uuid(), imageId: z.uuid() }), response: { 404: errorSchema, ...authErrorResponses } } },
    async (request, reply) => {
      const image = await productImageOf(app.db, request.params.id, request.params.imageId);
      if (!image) return apiError(reply, 404, "not_found", "Not found");
      const storage = await app.storage();
      if (!storage) return apiError(reply, 400, "storage_not_configured", "Object storage is not configured");
      const url = await storage.getSignedDownloadUrl(image.storageKey, "image", 300, { inlineContentType: image.mime });
      return reply.redirect(url, 302);
    },
  );
}
