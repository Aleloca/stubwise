import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
 * Le rotte che rifiutano il PAT nell'handler senza `config.reauth`: la
 * riconferma dell'identità stessa (lotto 6). Elenco chiuso, contato sul
 * sorgente (`return sessionRequired(reply)` di `me-security.ts`).
 */
const SESSION_ONLY = new Set(["POST /api/me/security/reauth", "POST /api/me/security/reauth/passkey/options", "POST /api/me/security/reauth/passkey/verify"]);
/**
 * Le rotte il cui scopo è restituire un segreto in chiaro (la chiave di un
 * agente di monitoraggio): si fanno solo dall'app (decisione del maintainer,
 * lotto 6). Elenco chiuso.
 */
const SECRET_ONCE = new Set(["POST /api/servers", "POST /api/servers/:id/regenerate-key"]);
/**
 * Le rotte che rifiutano il PAT nell'handler (`requireBrowserOrConfirmedDesktop`):
 * dichiarano anche `config.reauth`, così il catalogo non le offre. Elenco
 * chiuso, contato sul sorgente.
 */
const HANDLER_PAT_REFUSALS = ["POST /api/users/:id/password-reset", "POST /api/auth/me/password", "POST /api/auth/desktop-handoff"];

const here = dirname(fileURLToPath(import.meta.url));

/**
 * I nomi dei tool che il server MCP REGISTRA davvero (`buildServer` del
 * pacchetto, revisione del lotto 2, M8): non i `name:` dei sorgenti, che
 * possono stare su un ToolDef mai registrato. Il pacchetto non è una
 * dipendenza del server: si importa per percorso, come la fixture.
 */
let toolNamesCache: Promise<Set<string>> | null = null;
function mcpToolNames(): Promise<Set<string>> {
  toolNamesCache ??= (async () => {
    const serverModule = join(here, "../../../packages/mcp/src/server.ts");
    const { buildServer } = (await import(pathToFileURL(serverModule).href)) as {
      buildServer: (ctx: unknown) => { _registeredTools?: Record<string, unknown> };
    };
    const server = buildServer({ client: {}, config: { baseUrl: "http://localhost", token: "x", projectSlug: null } });
    return new Set(Object.keys(server._registeredTools ?? {}));
  })();
  return toolNamesCache;
}

/**
 * I codici d'errore del server (`apiError(reply, 403, "session_required", …)`,
 * `code: "too_late"`), letti dai sorgenti: in una `note` un nome fra backtick
 * con il trattino basso è un tool del pacchetto o uno di questi.
 */
function serverErrorCodes(): Set<string> {
  const codes = new Set<string>();
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (f.name.endsWith(".ts") && !f.name.endsWith(".test.ts")) {
        const src = readFileSync(full, "utf8");
        for (const m of src.matchAll(/apiError\([^,]+,\s*\d+,\s*"([a-z]+(?:_[a-z]+)+)"/g)) codes.add(m[1]!);
        for (const m of src.matchAll(/\b(?:code|error):\s*"([a-z]+(?:_[a-z]+)+)"/g)) codes.add(m[1]!);
      }
    }
  };
  walk(here);
  return codes;
}

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

/**
 * Le rotte delle DECISIONI e dell'inbox (lotto 1): passano solo dal loro tool
 * curato, dove la descrizione dice cosa succede dopo e i rifiuti si leggono per
 * quello che sono. Senza `tool`, `write_action` le chiamerebbe alla cieca.
 */
const CURATED_ROUTES: Record<string, string> = {
  "GET /api/inbox": "list_inbox",
  "POST /api/tickets/:id/approve-plan": "approve_plan",
  "POST /api/tickets/:id/reject-plan": "reject_plan",
  "POST /api/tickets/:id/pre-approve-plan": "pre_approve_plan",
  "DELETE /api/tickets/:id/pre-approve-plan": "revoke_plan_pre_approval",
  "POST /api/tickets/:id/questions/answer": "answer_agent_question",
  "POST /api/decisions/:id/answer": "answer_decision_request",
  "POST /api/decisions/:id/withdraw": "answer_decision_request",
  "POST /api/inbox/:id/actions/:action": "decide_pulse_proposal",
  "POST /api/me/mail/proposals/:id/confirm": "decide_mail_proposal",
  "POST /api/me/mail/proposals/:id/ignore": "decide_mail_proposal",
  "POST /api/me/mail/proposals/:id/hand": "decide_mail_proposal",
  "POST /api/me/mail/proposals/:id/reassign": "decide_mail_proposal",
  "POST /api/me/mail/proposals/:id/choose-project": "decide_mail_proposal",
  "POST /api/tickets/:id/repositories/:repositoryId/release": "merge_pull_request",
  "POST /api/tickets/:id/run-ai": "run_ticket",
};

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
          case "session_only":
            return SESSION_ONLY.has(r.key);
          case "secret_once":
            return SECRET_ONCE.has(r.key);
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

  it("le rotte delle decisioni sono azioni col loro tool curato (elenco chiuso)", async () => {
    const routes = new Map((await registered()).map((r) => [r.key, r]));
    const wrong = Object.entries(CURATED_ROUTES).flatMap(([key, tool]) => {
      const mcp = routes.get(key) ? mcpOf(routes.get(key)!) : undefined;
      return isMcpAction(mcp) && mcp.tool === tool ? [] : [`${key} → ${tool}`];
    });
    expect(wrong).toEqual([]);
  });

  it("le rotte di session_only sono quelle che rifiutano il PAT nell'handler (contate sul sorgente)", () => {
    const text = readFileSync(join(here, "routes", "me-security.ts"), "utf8");
    expect(text.match(/return sessionRequired\(reply\)/g)?.length ?? 0).toBe(SESSION_ONLY.size);
  });

  it("nessun segreto in chiaro arriva al modello: un campo dall'aria segreta nella risposta di un'azione è nascosto dall'MCP o dichiarato innocuo", async () => {
    const redacted = new Set(
      [...readFileSync(join(here, "../../../packages/mcp/src/tools/redact.ts"), "utf8").matchAll(/^ {2}"([A-Za-z0-9]+)",$/gm)].map((m) => m[1]!),
    );
    expect(redacted.has("ingestionKey")).toBe(true);
    const app = buildApp();
    await app.ready();
    const spec = app.swagger() as { paths: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }>> };
    await app.close();
    const SECRETISH = /^(key|token|secret|password|apiKey)$|(Secret|Token|Key|Password)$/;
    /** Nomi innocui per costruzione (un colore, un preset, una chiave PUBBLICA, un gate). */
    const INNOCENT_NAMES = new Set(["colorToken", "presetKey", "publicKey", "subKey", "residentKey", "resetPassword"]);
    /** `key` dove non è un segreto: il raggruppamento dei consumi, l'hook di un plugin, la chiave pubblica di un widget, il nome di una variabile. */
    const INNOCENT_PATHS = new Set(["rows.[].key", "rows.[].children.[].key", "plugins.[].inventory.hooks.[].key", "inventory.hooks.[].key", "widgets.[].key", "widget.key", "[].vars.[].key", "vars.[].key"]);
    const found: string[] = [];
    const walk = (schema: unknown, path: string, depth: number, key: string) => {
      if (!schema || typeof schema !== "object" || depth > 10) return;
      const sc = schema as { properties?: Record<string, unknown>; items?: unknown; anyOf?: unknown[]; oneOf?: unknown[]; allOf?: unknown[] };
      for (const [name, sub] of Object.entries(sc.properties ?? {})) {
        const at = `${path}${name}`;
        if (SECRETISH.test(name) && !redacted.has(name) && !INNOCENT_NAMES.has(name) && !INNOCENT_PATHS.has(at)) found.push(`${key}: ${at}`);
        walk(sub, `${at}.`, depth + 1, key);
      }
      if (sc.items) walk(sc.items, `${path}[].`, depth + 1, key);
      for (const sub of [...(sc.anyOf ?? []), ...(sc.oneOf ?? []), ...(sc.allOf ?? [])]) walk(sub, path, depth, key);
    };
    for (const r of await registered()) {
      if (!isMcpAction(mcpOf(r))) continue;
      const op = spec.paths[r.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}")]?.[r.method.toLowerCase()];
      for (const code of ["200", "201", "202"]) walk(op?.responses?.[code]?.content?.["application/json"]?.schema, "", 0, r.key);
    }
    expect(found).toEqual([]);
  });

  it("una voce con `tool` nomina un tool che il pacchetto MCP ha", async () => {
    const names = await mcpToolNames();
    expect(names.size).toBeGreaterThan(20);
    const unknown = (await registered()).flatMap((r) => {
      const mcp = mcpOf(r);
      return isMcpAction(mcp) && mcp.tool !== undefined && !names.has(mcp.tool) ? [`${r.key} → ${mcp.tool}`] : [];
    });
    expect(unknown).toEqual([]);
  });


  it("in una `note` ogni nome fra backtick col trattino basso è un tool registrato o un codice d'errore del server (revisione del lotto 2, M8)", async () => {
    const names = await mcpToolNames();
    const codes = serverErrorCodes();
    expect(codes.has("session_required")).toBe(true);
    const unknown = (await registered()).flatMap((r) => {
      const mcp = mcpOf(r);
      if (!isMcpAction(mcp) || mcp.note === undefined) return [];
      return [...mcp.note.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!).filter((t) => !names.has(t) && !codes.has(t)).map((t) => `${r.key} → ${t}`);
    });
    expect(unknown).toEqual([]);
  });

  it("un'azione con `partialReauth` ha una `note`: dice quale parte del corpo col PAT non passa (revisione del lotto 2, I6)", async () => {
    // La nota dice il rifiuto, non una frase qualunque (revisione del lotto 2, M8).
    const silent = (await registered())
      .filter((r) => r.route.config?.partialReauth && isMcpAction(mcpOf(r)) && !/session_required|riconferma/.test((mcpOf(r) as { note?: string }).note ?? ""))
      .map((r) => r.key);
    expect(silent).toEqual([]);
  });
});
