import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { apiError } from "../errors.js";
import { catalogEntries, catalogInput, visibleEntries, type CatalogEntry, type RouteCollector } from "../mcp/catalog.js";
import { authErrorResponses, errorSchema } from "./shared.js";

/**
 * `/api/mcp`: il catalogo delle azioni che `@stubwise/mcp` chiama col PAT
 * (design `docs/plans/2026-11-26-mcp-parita-design.md` § 2, `mcp/catalog.ts`).
 *
 * L'elenco non porta gli schemi (sarebbe grande quanto la spec): li dà la voce
 * singola. Le voci `instance` di cui chi chiede non ha il permesso non ci
 * sono, né nell'elenco né da sole: la rotta le rifiuterebbe comunque. Le voci
 * `project` ci sono tutte, perché il permesso dipende dal progetto e lo decide
 * la rotta.
 */
const entrySchema = z.object({
  action: z.string(),
  method: z.string(),
  path: z.string(),
  area: z.string(),
  summary: z.string(),
  effect: z.enum(["read", "write", "destructive"]),
  tool: z.string().optional(),
  note: z.string().optional(),
  redact: z.array(z.string()).optional(),
  access: z.string(),
});

const jsonSchema = z.record(z.string(), z.unknown());

const detailSchema = entrySchema.extend({
  input: z.object({
    params: jsonSchema.optional(),
    query: jsonSchema.optional(),
    body: jsonSchema.optional(),
    bodyKind: z.enum(["none", "json", "multipart"]),
  }),
});

export async function mcpRoutes(instance: FastifyInstance, opts: { collector: RouteCollector }): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  // Il registro è chiuso quando arriva la prima richiesta: lo si legge una volta.
  let cached: CatalogEntry[] | null = null;
  const entries = () => (cached ??= catalogEntries(opts.collector.routes()));
  const publicEntry = (entry: CatalogEntry) => {
    const rest: Partial<CatalogEntry> = { ...entry };
    delete rest.instancePermission;
    return rest as Omit<CatalogEntry, "instancePermission">;
  };

  app.get(
    "/catalog",
    {
      config: {
        access: { kind: "user" },
        mcp: {
          action: "mcp.catalog",
          summary: "L'elenco delle azioni che l'MCP può chiamare su questa istanza, senza gli schemi.",
          effect: "read",
        },
      },
      schema: { response: { 200: z.object({ actions: z.array(entrySchema) }), ...authErrorResponses } },
    },
    async (request) => ({ actions: visibleEntries(entries(), request.user!.instancePermissions).map(publicEntry) }),
  );

  app.get(
    "/catalog/:action",
    {
      config: {
        access: { kind: "user" },
        mcp: {
          action: "mcp.describe",
          summary: "Una voce del catalogo dell'MCP con gli schemi di parametri, query e corpo.",
          effect: "read",
        },
      },
      schema: {
        params: z.object({ action: z.string().min(1).max(200) }),
        response: { 200: detailSchema, ...authErrorResponses, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const entry = visibleEntries(entries(), request.user!.instancePermissions).find((e) => e.action === request.params.action);
      if (!entry) {
        return apiError(reply, 404, "not_found", "No such action in the catalog");
      }
      const spec = app.swagger() as Parameters<typeof catalogInput>[1];
      return { ...publicEntry(entry), input: catalogInput(entry, spec) };
    },
  );
}
