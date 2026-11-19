import type { RouteOptions } from "fastify";
import { CLAUDE_ACTION_FNS, CLAUDE_DECLARED_CLASS, CLAUDE_INVERSE_ONLY_FNS } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { SERVER_CATALOG } from "./catalog.js";

/**
 * Area 9, F7: la classe C NON si sceglie. Una voce è C se e solo se la sua
 * rotta dichiara `config.reauth` (la conferma chiederà la riconferma di chi
 * conferma). Le due cose stanno in due posti (il catalogo condiviso e la
 * rotta), e questo test le tiene uguali. Una rotta a riconferma PARZIALE
 * (`partialReauth`) non fa C: i segreti non stanno negli argomenti (M-4).
 */
async function routeConfigs(): Promise<Map<string, { reauth?: unknown; partialReauth?: unknown }>> {
  const routes = new Map<string, { reauth?: unknown; partialReauth?: unknown }>();
  const app = buildApp({
    onRoute: (route: RouteOptions) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const url = route.url.length > 1 ? route.url.replace(/\/$/, "") : route.url;
      for (const m of methods) {
        if (m === "HEAD" || m === "OPTIONS") continue;
        routes.set(`${m} ${url}`, { reauth: route.config?.reauth, partialReauth: route.config?.partialReauth });
      }
    },
  });
  await app.ready();
  await app.close();
  return routes;
}

describe("la classe C segue la rotta (area 9, F7, M-1 = a)", () => {
  it("ogni voce proponibile ha una rotta registrata, ed è C se e solo se la rotta chiede la riconferma", async () => {
    const routes = await routeConfigs();
    const mismatches: string[] = [];
    for (const fn of CLAUDE_ACTION_FNS) {
      if (fn === "pageAction") continue;
      const entry = SERVER_CATALOG.get(fn);
      if (!entry) {
        mismatches.push(`${fn}: nessuna voce nel catalogo del server`);
        continue;
      }
      const route = routes.get(entry.route);
      if (!route) {
        mismatches.push(`${fn}: la rotta ${entry.route} non è registrata`);
        continue;
      }
      const wantsC = route.reauth !== undefined;
      const isC = CLAUDE_DECLARED_CLASS[fn] === "C";
      if (wantsC !== isC) mismatches.push(`${fn}: dichiarata ${CLAUDE_DECLARED_CLASS[fn]}, la rotta ${entry.route} ${wantsC ? "chiede" : "non chiede"} la riconferma`);
    }
    expect(mismatches).toEqual([]);
    // Il test non gira a vuoto.
    expect(CLAUDE_ACTION_FNS.filter((f) => !CLAUDE_INVERSE_ONLY_FNS.includes(f)).length).toBeGreaterThan(10);
  });
});
