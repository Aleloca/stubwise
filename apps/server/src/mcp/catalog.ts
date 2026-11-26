import type { RouteOptions } from "fastify";
import type { RouteAccess } from "../auth/access.js";
import { isMcpAction, type RouteMcpAction } from "./route-mcp.js";

/**
 * Il catalogo delle azioni che `@stubwise/mcp` chiama col PAT (design
 * `docs/plans/2026-11-26-mcp-parita-design.md` § 2): una voce per ogni rotta
 * con `config.mcp.action`, presa dal registro di QUESTO server, così l'MCP
 * (uno per tutte le istanze) vede le rotte e gli schemi della versione che ha
 * davanti. Il catalogo non è un permesso: la rotta resta l'autorità.
 */

/** Le rotte del registro, raccolte da un hook `onRoute` di `buildApp`. */
export interface RouteCollector {
  hook: (route: RouteOptions) => void;
  routes: () => readonly RouteOptions[];
}

/**
 * Tiene gli OGGETTI rotta e legge la config solo dopo: un hook `onRoute` di un
 * plugin (la cassaforte aggiunge `browserOnly`) la riassegna dopo quello
 * della radice.
 */
export function createRouteCollector(): RouteCollector {
  const routes: RouteOptions[] = [];
  return { hook: (route) => void routes.push(route), routes: () => routes };
}

export interface CatalogEntry {
  action: string;
  method: string;
  /** Il percorso con i parametri `:nome`, come lo chiama il client. */
  path: string;
  /** Il primo segmento dopo `/api` (`tickets`, `me`…). */
  area: string;
  summary: string;
  effect: RouteMcpAction["effect"];
  tool?: string;
  note?: string;
  /** `user`, `project:<permesso>` o `instance:<permesso>`. */
  access: string;
  /** Il permesso d'istanza che la rotta chiede, per il filtro del catalogo. */
  instancePermission?: string;
}

export interface CatalogInput {
  params?: JsonSchema;
  query?: JsonSchema;
  body?: JsonSchema;
  /** `multipart`: un file, che porta un tool curato, non `write_action`. */
  bodyKind: "none" | "json" | "multipart";
}

type JsonSchema = Record<string, unknown>;

function normalizeUrl(url: string): string {
  return url.length > 1 ? url.replace(/\/$/, "") : url;
}

function accessLabel(access: RouteAccess | undefined): { access: string; instancePermission?: string } {
  if (!access) return { access: "user" };
  if (access.kind === "project") return { access: `project:${access.permission}` };
  if (access.kind === "instance") return { access: `instance:${access.permission}`, instancePermission: access.permission };
  return { access: access.kind };
}

/** Le voci del catalogo, una per rotta con `config.mcp.action`, in ordine di `action`. */
export function catalogEntries(routes: readonly RouteOptions[]): CatalogEntry[] {
  const out = new Map<string, CatalogEntry>();
  for (const route of routes) {
    const mcp = route.config?.mcp;
    if (!isMcpAction(mcp)) continue;
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter((m) => m !== "HEAD" && m !== "OPTIONS");
    for (const method of methods) {
      const path = normalizeUrl(route.url);
      out.set(`${method} ${path}`, {
        action: mcp.action,
        method,
        path,
        area: path.split("/")[2] ?? "",
        summary: mcp.summary,
        effect: mcp.effect,
        ...(mcp.tool ? { tool: mcp.tool } : {}),
        ...(mcp.note ? { note: mcp.note } : {}),
        ...accessLabel(route.config?.access),
      });
    }
  }
  return [...out.values()].sort((a, b) => a.action.localeCompare(b.action));
}

/** Le voci che chi ha questi permessi d'istanza vede: le `instance` senza il permesso no. */
export function visibleEntries(entries: readonly CatalogEntry[], instancePermissions: ReadonlySet<string>): CatalogEntry[] {
  return entries.filter((e) => e.instancePermission === undefined || instancePermissions.has(e.instancePermission));
}

interface OpenApiParameter {
  in: string;
  name: string;
  required?: boolean;
  schema?: JsonSchema;
  description?: string;
}

interface OpenApiOperation {
  parameters?: OpenApiParameter[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
}

/** `/api/tickets/:id` → `/api/tickets/{id}`, la forma dei path della spec. */
export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function parametersSchema(parameters: OpenApiParameter[], where: "path" | "query"): JsonSchema | undefined {
  const own = parameters.filter((p) => p.in === where);
  if (own.length === 0) return undefined;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const p of own) {
    properties[p.name] = { ...(p.schema ?? {}), ...(p.description ? { description: p.description } : {}) };
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/** L'input di una voce (parametri, query, corpo), dalla spec OpenAPI del server. */
export function catalogInput(entry: Pick<CatalogEntry, "method" | "path">, spec: { paths?: Record<string, Record<string, OpenApiOperation>> }): CatalogInput {
  const operation = spec.paths?.[openApiPath(entry.path)]?.[entry.method.toLowerCase()];
  const parameters = operation?.parameters ?? [];
  const content = operation?.requestBody?.content ?? {};
  const json = content["application/json"]?.schema;
  const multipart = content["multipart/form-data"] !== undefined;
  const params = parametersSchema(parameters, "path");
  const query = parametersSchema(parameters, "query");
  return {
    ...(params ? { params } : {}),
    ...(query ? { query } : {}),
    ...(json ? { body: json } : {}),
    bodyKind: json ? "json" : multipart ? "multipart" : "none",
  };
}
