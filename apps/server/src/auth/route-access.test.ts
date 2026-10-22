import type { RouteOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { LEGACY_ROUTES } from "./legacy-routes.js";

/**
 * Ogni rotta dichiara il suo accesso in `config.access` (vedi `access.ts`).
 * Le rotte che ancora non lo fanno stanno in `LEGACY_ROUTES`, elenco esplicito
 * che può solo SCENDERE: una rotta nuova senza dichiarazione fa fallire il
 * test, e così una voce dell'elenco che nel frattempo l'ha guadagnata (va
 * tolta dall'elenco, non lasciata lì a coprire una regressione futura).
 */

interface CollectedRoute {
  key: string;
  hasAccess: boolean;
}

/**
 * `METHOD path`, una voce per metodo. Lo slash finale si toglie: con
 * `prefixTrailingSlash: "both"` una rotta "/" sotto un prefisso è registrata
 * due volte (con e senza slash), ma è la stessa rotta.
 */
function collect(route: RouteOptions, into: Map<string, CollectedRoute>): void {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  const url = route.url.length > 1 ? route.url.replace(/\/$/, "") : route.url;
  for (const method of methods) {
    // HEAD e OPTIONS non sono rotte nostre: Fastify aggiunge da sé un HEAD
    // per ogni GET, con la stessa config.
    if (method === "HEAD" || method === "OPTIONS") continue;
    const key = `${method} ${url}`;
    const hasAccess = route.config?.access !== undefined;
    const prev = into.get(key);
    into.set(key, { key, hasAccess: (prev?.hasAccess ?? false) || hasAccess });
  }
}

async function registeredRoutes(): Promise<CollectedRoute[]> {
  const routes = new Map<string, CollectedRoute>();
  const app = buildApp({ onRoute: (route) => collect(route, routes) });
  await app.ready();
  await app.close();
  return [...routes.values()].sort((a, b) => a.key.localeCompare(b.key));
}

describe("ogni rotta dichiara config.access", () => {
  it("nessuna rotta senza config.access fuori da LEGACY_ROUTES", async () => {
    const legacy = new Set(LEGACY_ROUTES);
    const undeclared = (await registeredRoutes())
      .filter((r) => !r.hasAccess && !legacy.has(r.key))
      .map((r) => r.key);
    expect(undeclared).toEqual([]);
  });

  it("LEGACY_ROUTES solo scende: nessuna voce ha già config.access o non esiste più", async () => {
    const routes = new Map((await registeredRoutes()).map((r) => [r.key, r]));
    const stale = LEGACY_ROUTES.filter((key) => {
      const route = routes.get(key);
      return !route || route.hasAccess;
    });
    expect(stale).toEqual([]);
  });

  it("LEGACY_ROUTES è ordinato e senza doppioni", () => {
    expect([...new Set(LEGACY_ROUTES)].sort((a, b) => a.localeCompare(b))).toEqual([
      ...LEGACY_ROUTES,
    ]);
  });
});
