import type { RouteOptions } from "fastify";
import { CLAUDE_ACTION_FNS, CLAUDE_DECLARED_CLASS, CLAUDE_INVERSE_ONLY_FNS, CLAUDE_INSTANCE_PERMISSION } from "@stubwise/shared";
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
type RouteConfig = { reauth?: unknown; partialReauth?: unknown; archived?: unknown; access?: { kind?: string; permission?: string } };
async function routeConfigs(): Promise<Map<string, RouteConfig>> {
  const routes = new Map<string, RouteConfig>();
  const app = buildApp({
    onRoute: (route: RouteOptions) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const url = route.url.length > 1 ? route.url.replace(/\/$/, "") : route.url;
      for (const m of methods) {
        if (m === "HEAD" || m === "OPTIONS") continue;
        routes.set(`${m} ${url}`, { reauth: route.config?.reauth, partialReauth: route.config?.partialReauth, archived: route.config?.archived, access: route.config?.access });
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
      // Area 9, F7: l'eccezione all'archivio e il permesso sono quelli della rotta.
      if (entry.archived !== route.archived) mismatches.push(`${fn}: archived ${String(entry.archived)}, la rotta ${String(route.archived)}`);
      const want = route.access;
      const has = entry.access as { kind: string; permission?: string };
      if (want && (want.kind !== has.kind || want.permission !== has.permission)) {
        mismatches.push(`${fn}: accesso ${has.kind}/${String(has.permission)}, la rotta ${String(want.kind)}/${String(want.permission)}`);
      }
    }
    expect(mismatches).toEqual([]);
    // Il test non gira a vuoto.
    expect(CLAUDE_ACTION_FNS.filter((f) => !CLAUDE_INVERSE_ONLY_FNS.includes(f)).length).toBeGreaterThan(10);
  });
});

describe("il permesso d'istanza delle firme del prompt è quello del catalogo (area 9, F7)", () => {
  it("una voce ha CLAUDE_INSTANCE_PERMISSION se e solo se il suo accesso è d'istanza, con lo stesso permesso", () => {
    const mismatches: string[] = [];
    for (const [fn, entry] of SERVER_CATALOG) {
      const declared = CLAUDE_INSTANCE_PERMISSION[fn];
      const actual = entry.access.kind === "instance" ? entry.access.permission : undefined;
      if (declared !== actual) mismatches.push(`${fn}: firme ${String(declared)}, catalogo ${String(actual)}`);
    }
    expect(mismatches).toEqual([]);
    expect(Object.keys(CLAUDE_INSTANCE_PERMISSION).length).toBeGreaterThan(10);
  });
});
