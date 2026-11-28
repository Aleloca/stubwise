import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { RouteMcp } from "./route-mcp.js";

// D10, decisione del maintainer (28 nov 2026): le rotte che servono i tool
// DEDICATI di Claude Code (`packages/mcp`, i comandi del plugin) restano come
// superficie propria dell'MCP, anche se l'app non le chiama. Lo dichiarano con
// `owner: "mcp"` sull'azione del catalogo, così lo script delle rotte non le
// mette fra quelle «senza chiamanti» da togliere, e chi le tocca lo sa.
// L'elenco è CHIUSO: una rotta nuova dell'MCP si aggiunge qui, apposta.

const MCP_OWNED = [
  "GET /api/backlog/:id",
  "PATCH /api/backlog/:id",
  "POST /api/backlog/:id/convert",
  "PUT /api/backlog/:id/design",
  "PUT /api/backlog/:id/plan",
  "POST /api/backlog/from-design",
  "GET /api/backlog/jobs/:jobId",
  "PUT /api/tickets/:id/design",
  "PUT /api/tickets/:id/plan",
  "GET /api/projects/:projectId/briefs",
  "GET /api/mcp/catalog",
  "GET /api/mcp/catalog/:action",
].sort();

async function declared(): Promise<{ owned: string[]; withoutAction: string[] }> {
  const routes: { key: string; config: unknown }[] = [];
  const app = buildApp({
    onRoute: (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const url = route.url.length > 1 ? route.url.replace(/\/$/, "") : route.url;
      for (const method of methods) if (method !== "HEAD" && method !== "OPTIONS") routes.push({ key: `${method} ${url}`, config: route });
    },
  });
  await app.ready();
  await app.close();
  const owned = new Set<string>();
  const withoutAction = new Set<string>();
  for (const r of routes) {
    const mcp = (r.config as { config?: { mcp?: RouteMcp & { owner?: string } } }).config?.mcp;
    if (mcp?.owner !== "mcp") continue;
    owned.add(r.key);
    if (!("action" in mcp)) withoutAction.add(r.key);
  }
  return { owned: [...owned].sort(), withoutAction: [...withoutAction].sort() };
}

describe("le rotte dell'MCP per scelta (D10)", () => {
  it("sono esattamente le dodici dei tool dedicati, e ognuna è un'azione del catalogo", async () => {
    const { owned, withoutAction } = await declared();
    expect(owned).toEqual(MCP_OWNED);
    expect(withoutAction).toEqual([]);
  });
});
