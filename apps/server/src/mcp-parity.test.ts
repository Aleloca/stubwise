import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { PENDING_MCP, PENDING_MCP_MAX } from "./mcp/pending.js";
import { impliedMcpExclusion, isMcpAction, type RouteMcp } from "./mcp/route-mcp.js";

/**
 * La parità dell'MCP con l'app (design
 * `docs/plans/2026-11-26-mcp-parita-design.md` § 2): ogni rotta del registro
 * è un'azione del catalogo (`config.mcp.action`), un'esclusione DICHIARATA da
 * un elenco chiuso, o un'esclusione che dà il registro stesso (riconferma,
 * cassaforte, login: `impliedMcpExclusion`). Non esiste un'esclusione «non la
 * usa l'app»: così la parità non dipende da un elenco a mano.
 *
 * Transizione: `PENDING_MCP` (`mcp/pending.ts`) elenca le rotte non ancora
 * dichiarate, e si può solo ACCORCIARE. Sparisce all'ultimo lotto.
 */

interface Collected {
  key: string;
  method: string;
  url: string;
  route: RouteOptions;
}

/** Gli oggetti rotta; la config si legge DOPO `ready` (un `onRoute` di plugin la riassegna). */
async function registered(): Promise<Collected[]> {
  const seen = new Map<string, Collected>();
  const app = buildApp({
    onRoute: (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const url = route.url.length > 1 ? route.url.replace(/\/$/, "") : route.url;
      for (const method of methods) {
        if (method === "HEAD" || method === "OPTIONS") continue;
        const key = `${method} ${url}`;
        // Con `prefixTrailingSlash: "both"` una rotta compare due volte: basta una che dichiari.
        if (!seen.has(key) || seen.get(key)!.route.config?.mcp === undefined) seen.set(key, { key, method, url, route });
      }
    },
  });
  await app.ready();
  await app.close();
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function mcpOf(r: Collected): RouteMcp | undefined {
  return r.route.config?.mcp;
}

function implied(r: Collected) {
  const c = r.route.config ?? {};
  return impliedMcpExclusion({
    accessKind: c.access?.kind,
    reauth: c.reauth,
    browserOnly: c.browserOnly,
    desktopVault: c.desktopVault,
    desktopOnly: c.desktopOnly,
    desktopRead: c.desktopRead,
    credentialDoor: c.credentialDoor,
  });
}

/** Le rotte pubbliche d'infrastruttura: elenco chiuso. */
const INFRA = new Set(["GET /health", "GET /api/openapi.json"]);
/** Le rotte del PAT dell'app desktop: elenco chiuso. */
const DESKTOP_LINK = new Set(["POST /api/auth/desktop-reauth"]);
/**
 * Le rotte che rifiutano il PAT nell'handler (`requireBrowserOrConfirmedDesktop`):
 * dichiarano anche `config.reauth`, così il catalogo non le offre. Elenco
 * chiuso, contato sul sorgente.
 */
const HANDLER_PAT_REFUSALS = ["POST /api/users/:id/password-reset", "POST /api/auth/me/password", "POST /api/auth/desktop-handoff"];

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Le rotte che leggono un FILE (`request.file(`, contate sul sorgente): un
 * corpo multipart non passa da `write_action`, quindi una loro azione ha un
 * tool curato (revisione del lotto 0, M2).
 */
const MULTIPART_ROUTES = [
  "POST /api/projects/:projectId/drive/files",
  "POST /api/product-pages/:id/images",
  "POST /api/chat/channels/:id/attachments",
  "POST /api/tickets/:ticketId/attachments",
  "POST /api/me/mail/drafts/:id/attachments",
];

describe("parità MCP: ogni rotta dichiara config.mcp", () => {
  it("ogni rotta è un'azione, un'esclusione dichiarata, un'esclusione del registro o in PENDING_MCP", async () => {
    const pending = new Set(PENDING_MCP);
    const missing = (await registered()).filter((r) => mcpOf(r) === undefined && implied(r) === null && !pending.has(r.key)).map((r) => r.key);
    expect(missing).toEqual([]);
  });

  it("PENDING_MCP si può solo accorciare: niente voci dichiarate, escluse dal registro, doppie o inesistenti", async () => {
    const routes = new Map((await registered()).map((r) => [r.key, r]));
    const stale = PENDING_MCP.filter((key) => {
      const r = routes.get(key);
      return r === undefined || mcpOf(r) !== undefined || implied(r) !== null;
    });
    expect(stale).toEqual([]);
    expect(new Set(PENDING_MCP).size).toBe(PENDING_MCP.length);
    // Una rotta NUOVA non si accoda: il tetto si abbassa soltanto (revisione del lotto 0, I2).
    expect(PENDING_MCP.length).toBeLessThanOrEqual(PENDING_MCP_MAX);
  });

  it("una rotta esclusa dal registro (riconferma, cassaforte, login) non dichiara nulla", async () => {
    const declared = (await registered()).filter((r) => implied(r) !== null && mcpOf(r) !== undefined).map((r) => `${r.key} (${implied(r)})`);
    expect(declared).toEqual([]);
  });

  it("ogni esclusione dichiarata ha il suo motivo vero", async () => {
    const routes = await registered();
    const actions = new Set(routes.flatMap((r) => (isMcpAction(mcpOf(r)) ? [(mcpOf(r) as { action: string }).action] : [])));
    const wrong: string[] = [];
    for (const r of routes) {
      const mcp = mcpOf(r);
      if (mcp === undefined || isMcpAction(mcp)) continue;
      const isPublic = r.route.config?.access?.kind === "public";
      const ok = (() => {
        switch (mcp.exclude) {
          case "vault":
            return /^\/api\/(vault|credentials)(\/|$)/.test(r.url) || /^\/api\/projects\/:projectId\/credentials(\/|$)/.test(r.url);
          case "login":
            return isPublic && r.url.startsWith("/api/auth/");
          case "inbound":
            return isPublic && !r.url.startsWith("/api/auth/") && !INFRA.has(r.key);
          case "infra":
            return INFRA.has(r.key);
          case "stream":
            return mcp.instead !== undefined && actions.has(mcp.instead);
          case "desktop_link":
            return DESKTOP_LINK.has(r.key);
          default:
            return false;
        }
      })();
      if (!ok || (mcp.exclude !== "stream" && mcp.instead !== undefined)) wrong.push(`${r.key} → ${mcp.exclude}`);
    }
    expect(wrong).toEqual([]);
  });

  it("le azioni: id unico e ben formato, un sommario, l'effetto che torna col metodo", async () => {
    const seen = new Map<string, string>();
    const wrong: string[] = [];
    for (const r of await registered()) {
      const mcp = mcpOf(r);
      if (!isMcpAction(mcp)) continue;
      if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(mcp.action)) wrong.push(`${r.key}: action «${mcp.action}»`);
      if (seen.has(mcp.action)) wrong.push(`${r.key}: action «${mcp.action}» già di ${seen.get(mcp.action)}`);
      seen.set(mcp.action, r.key);
      if (mcp.summary.trim().length < 10) wrong.push(`${r.key}: sommario vuoto`);
      if (r.method === "GET" && mcp.effect !== "read") wrong.push(`${r.key}: GET ma ${mcp.effect}`);
      if (r.method !== "GET" && mcp.effect === "read") wrong.push(`${r.key}: ${r.method} ma read`);
      if (r.method === "DELETE" && mcp.effect !== "destructive") wrong.push(`${r.key}: DELETE ma ${mcp.effect}`);
    }
    expect(wrong).toEqual([]);
  });

  it("un rifiuto del PAT scritto nell'handler sta su una rotta con config.reauth (elenco chiuso, contato sul sorgente)", async () => {
    const routes = new Map((await registered()).map((r) => [r.key, r]));
    for (const key of HANDLER_PAT_REFUSALS) {
      expect(routes.get(key)?.route.config?.reauth, key).toBeTruthy();
    }
    // Tutto `src/`, ricorsivo (revisione del lotto 0, M4): un rifiuto in un servizio conta come in una rotta.
    const sources = (readdirSync(here, { recursive: true }) as string[]).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== join("auth", "access.ts"),
    );
    const calls = sources.reduce((n, f) => n + (readFileSync(join(here, f), "utf8").match(/requireBrowserOrConfirmedDesktop\(/g)?.length ?? 0), 0);
    expect(calls).toBe(HANDLER_PAT_REFUSALS.length);
  });

  it("una rotta che legge un file, se è un'azione, ha un tool curato (elenco chiuso, contato sul sorgente)", async () => {
    const routes = new Map((await registered()).map((r) => [r.key, r]));
    const sources = (readdirSync(here, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const reads = sources.reduce((n, f) => n + (readFileSync(join(here, f), "utf8").match(/\brequest\.file\(/g)?.length ?? 0), 0);
    expect(reads).toBe(MULTIPART_ROUTES.length);
    const wrong = MULTIPART_ROUTES.filter((key) => {
      const r = routes.get(key);
      if (!r) return true;
      const mcp = mcpOf(r);
      return isMcpAction(mcp) && mcp.tool === undefined;
    });
    expect(wrong).toEqual([]);
  });

  it("una voce con `tool` nomina un tool che il pacchetto MCP ha", async () => {
    const toolsDir = join(here, "../../../packages/mcp/src/tools");
    const names = new Set(
      readdirSync(toolsDir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        // Il `name` di un ToolDef: due spazi, a inizio riga (revisione del lotto 0, M7).
        .flatMap((f) => [...readFileSync(join(toolsDir, f), "utf8").matchAll(/^ {2}name: "([a-z_]+)",$/gm)].map((m) => m[1]!)),
    );
    expect(names.size).toBeGreaterThan(20);
    const unknown = (await registered()).flatMap((r) => {
      const mcp = mcpOf(r);
      return isMcpAction(mcp) && mcp.tool !== undefined && !names.has(mcp.tool) ? [`${r.key} → ${mcp.tool}`] : [];
    });
    expect(unknown).toEqual([]);
  });
});
