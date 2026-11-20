import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { productPageViewSchema, productSpaceSchema } from "@stubwise/shared";
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
import { authErrorResponses, errorSchema } from "./shared.js";

// Area 11, F1 — lo spazio Product, sotto `/api`. Le regole stanno nei servizi
// (`services/product-docs.ts`); qui le rotte, con l'accesso dichiarato:
// `docs.view` per leggere, `docs.edit` per scrivere, invisibile = 404.

const SPACE_VIEW: RouteAccess = { kind: "project", permission: "docs.view", project: fromParam("projectId") };
const SPACE_EDIT: RouteAccess = { kind: "project", permission: "docs.edit", project: fromParam("projectId") };
const PAGE_EDIT: RouteAccess = { kind: "project", permission: "docs.edit", project: fromProductPage("id") };

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
}
