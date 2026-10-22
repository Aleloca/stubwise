import type { RouteOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

/**
 * Ogni rotta dichiara il suo accesso in `config.access` (vedi `access.ts`),
 * anche quelle pubbliche (`{ kind: "public" }`): una rotta senza
 * dichiarazione fa fallire il test. Non esiste un elenco di eccezioni — la
 * transizione dai `preHandler` scritti a mano si è chiusa il 22 ott 2026 —
 * e non va reintrodotto: una rotta pubblica con la sua autenticazione
 * (firma HMAC, chiave del server, token del widget) dichiara `public` e
 * tiene il suo controllo nel `preValidation` o nell'handler.
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
  it("nessuna rotta senza config.access", async () => {
    const undeclared = (await registeredRoutes()).filter((r) => !r.hasAccess).map((r) => r.key);
    expect(undeclared).toEqual([]);
  });

  it("il registro vede davvero le rotte (non passa a vuoto)", async () => {
    const keys = (await registeredRoutes()).map((r) => r.key);
    expect(keys).toContain("GET /health");
    expect(keys).toContain("POST /webhooks/git/:projectSlug");
    expect(keys.length).toBeGreaterThan(100);
  });
});
