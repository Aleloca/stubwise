/**
 * Il registro delle rotte contro i chiamanti veri (ritiro del web vecchio,
 * D4, `docs/plans/2026-11-28-ritiro-web-vecchio-piano.md` §3).
 *
 * Domanda: quali rotte del server NON chiama nessun client dell'app? Quelle
 * si tolgono allo spegnimento, anche se l'MCP le espone (la parità MCP è
 * «tutto ciò che fa l'app»: l'MCP NON conta come chiamante).
 *
 * Come:
 *  1. le rotte: `buildApp({ onRoute })`, come il test del registro
 *     (`src/auth/route-access.test.ts`), con metodo, percorso, `config.mcp`;
 *  2. l'api-client: per ogni gruppo di `createEndpoints` (`client.ts`), i
 *     metodi e i percorsi che chiamano (`request("VERB", \`/api/…\`)`, o un
 *     percorso `/api/…` restituito, come `imagePath`);
 *  3. i chiamanti: nel codice NON di test del desktop (renderer e main), del
 *     widget, dell'agente di monitoraggio e dell'SDK, le chiamate
 *     `.<gruppo>.<metodo>(` e i percorsi `/api/…` scritti a mano;
 *  4. le rotte «esterne» per dichiarazione (`mcp.exclude`: webhook in
 *     ingresso, login, infra, stream, …) sono a parte: le chiama qualcuno
 *     fuori dal codice dell'app (una piattaforma, Caddy, un browser).
 *
 * È un'euristica sul sorgente: il rapporto ha anche i «dubbi» (un percorso
 * che compare nel codice dell'app senza una chiamata tracciata). L'elenco
 * finale lo rivede una persona.
 *
 * Uso (dalla radice del repo, coi pacchetti buildati):
 *   pnpm --filter @stubwise/server exec tsx scripts/route-callers.ts [--out file.md] [--json file.json]
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteOptions } from "fastify";
import { buildApp } from "../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");

interface Route {
  method: string;
  url: string;
  norm: string;
  mcp: string;
  exclude: string | null;
}

/** `:id`, `${seg(id)}` e simili diventano `:`; via lo slash finale e la query. */
function normalize(path: string): string {
  // Le espressioni `${…}`, anche con graffe dentro (`${toQuery({ a })}`): dopo
  // un `/` sono un segmento (`:`), attaccate a un segmento una query (via).
  let p = "";
  for (let i = 0; i < path.length; i++) {
    if (path[i] === "$" && path[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      for (; j < path.length && depth > 0; j++) {
        if (path[j] === "{") depth++;
        else if (path[j] === "}") depth--;
      }
      if (p.endsWith("/")) p += ":";
      i = j - 1;
      continue;
    }
    p += path[i];
  }
  p = p.split("?")[0]!;
  p = p.replace(/:[A-Za-z_][\w]*/g, ":");
  if (p.length > 1) p = p.replace(/\/$/, "");
  return p;
}

// --- 1. le rotte ---------------------------------------------------------------

async function routes(): Promise<Route[]> {
  const seen = new Map<string, Route>();
  const app = buildApp({
    onRoute: (route: RouteOptions) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const url = route.url.length > 1 ? route.url.replace(/\/$/, "") : route.url;
      const mcp = (route.config as { mcp?: { action?: string; exclude?: string } } | undefined)?.mcp;
      for (const method of methods) {
        if (method === "HEAD" || method === "OPTIONS") continue;
        seen.set(`${method} ${url}`, {
          method,
          url,
          norm: normalize(url),
          mcp: mcp?.action ?? (mcp?.exclude ? `(exclude: ${mcp.exclude})` : "—"),
          exclude: mcp?.exclude ?? null,
        });
      }
    },
  } as never);
  await app.ready();
  await app.close();
  return [...seen.values()].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
}

// --- 2. l'api-client -----------------------------------------------------------

const read = (file: string) => readFileSync(join(repo, file), "utf8");

function sources(dir: string, exts = /\.(ts|tsx|mjs|js)$/): string[] {
  const abs = join(repo, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const full = join(abs, name);
    if (statSync(full).isDirectory())
      return ["node_modules", "dist", "out", "dist-web", "test", "__tests__", "e2e"].includes(name) ? [] : sources(relative(repo, full), exts);
    return exts.test(name) && !/\.(test|spec|fixture)\.(ts|tsx|mjs|js)$/.test(name) ? [relative(repo, full)] : [];
  });
}

/** I percorsi chiamati in un pezzo di codice: `request("VERB", path)` e i letterali `/api/…`. */
function callsIn(code: string): { method: string | null; norm: string }[] {
  const out: { method: string | null; norm: string }[] = [];
  const req = /request\(\s*["'](GET|POST|PUT|PATCH|DELETE)["']\s*,\s*([`"'])([^`"']*?)\2/g;
  for (const m of code.matchAll(req)) out.push({ method: m[1]!, norm: normalize(m[3]!) });
  // Anche con l'origine davanti (`${instance}/api/…`, il main del Mac).
  const literal = /([`"'])(?:\$\{[^}]*\})?(\/(?:api|widget|ingest|monitor|webhooks|go)\/[^`"'\s]*)\1/g;
  for (const m of code.matchAll(literal)) out.push({ method: null, norm: normalize(m[2]!) });
  return out;
}

/**
 * I percorsi costruiti con un aiuto del file (`const base = (code) =>
 * \`/api/automations/${seg(code)}\``, `const BASE = "/api/…"`): ogni
 * `${base(…)}`/`${BASE}` diventa il suo modello, così il percorso intero si
 * riconosce.
 */
function expandHelpers(code: string, from: string = code): string {
  const helpers = new Map<string, string>();
  for (const m of from.matchAll(/const (\w+)\s*=\s*\([^)]*\)(?:\s*:\s*\w+)?\s*=>\s*([`"'])(\/[^`"']*)\2/g)) helpers.set(m[1]!, m[3]!);
  for (const m of from.matchAll(/const (\w+)\s*=\s*([`"'])(\/[^`"']*)\2/g)) helpers.set(m[1]!, m[3]!);
  let out = code;
  for (let pass = 0; pass < 3; pass++)
    for (const [name, template] of helpers) out = out.replace(new RegExp(`\\$\\{${name}(?:\\([^}]*\\))?\\}`, "g"), template);
  return out;
}

/** gruppo.metodo → percorsi, dall'api-client. */
function apiClientMethods(): Map<string, { method: string | null; norm: string }[]> {
  const client = read("packages/api-client/src/client.ts");
  const groupOf = new Map<string, string>(); // createXEndpoints → gruppo
  for (const m of client.matchAll(/^\s+(\w+):\s*(create\w+Endpoints)\(request\)/gm)) groupOf.set(m[2]!, m[1]!);
  const files = sources("packages/api-client/src/endpoints");
  const out = new Map<string, { method: string | null; norm: string }[]>();
  for (const file of files) {
    const code = read(file);
    for (const fn of code.matchAll(/export function (create\w+Endpoints)\s*\(/g)) {
      const group = groupOf.get(fn[1]!);
      if (!group) continue;
      // Il corpo della funzione: fino al prossimo `export function` o alla fine.
      const start = fn.index!;
      const next = code.indexOf("\nexport function ", start + 1);
      // Gli aiuti del corpo prima (due funzioni dello stesso file possono avere
      // ciascuna il suo `base`), poi quelli del file.
      const raw = code.slice(start, next < 0 ? code.length : next);
      const body = expandHelpers(expandHelpers(raw), code);
      // I metodi: righe a 4 spazi `nome(` o `async nome(`; un sotto-oggetto `nome: {` dà `gruppo.nome.metodo`.
      const lines = body.split("\n");
      let current: string | null = null;
      let sub: string | null = null;
      let chunk: string[] = [];
      const flush = () => {
        if (current) {
          const key = sub ? `${group}.${sub}.${current}` : `${group}.${current}`;
          out.set(key, [...(out.get(key) ?? []), ...callsIn(chunk.join("\n"))]);
        }
        chunk = [];
      };
      for (const line of lines) {
        const top = /^ {4}(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\(/.exec(line);
        const subObj = /^ {4}(\w+):\s*\{\s*$/.exec(line);
        const inSub = /^ {6}(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\(/.exec(line);
        if (subObj) {
          flush();
          current = null;
          sub = subObj[1]!;
        } else if (top) {
          flush();
          sub = null;
          current = top[1]!;
        } else if (sub && inSub) {
          flush();
          current = inSub[1]!;
        }
        chunk.push(line);
      }
      flush();
    }
  }
  return out;
}

// --- 3. i chiamanti dell'app -----------------------------------------------------

const CALLER_ROOTS = [
  // Tutto il renderer: una pagina può comporre un percorso (sovrastima: si toglie di meno).
  "apps/desktop/src/renderer",
  "apps/desktop/src/main",
  "apps/desktop/src/preload",
  "packages/widget/src",
  "packages/agent/src",
  "packages/sdk/src",
];

interface Callers {
  methods: Set<string>; // gruppo.metodo usati
  literals: { method: string | null; norm: string; file: string }[];
}

function callers(known: Map<string, unknown>, roots: readonly string[] = CALLER_ROOTS): Callers {
  const methods = new Set<string>();
  const literals: Callers["literals"] = [];
  for (const root of roots) {
    for (const file of sources(root)) {
      let code = expandHelpers(read(file));
      // Il client dell'MCP sceglie la radice con `this.basePath(target)`: le due varianti.
      if (code.includes("${this.basePath("))
        code = `${code}\n${code.replace(/\$\{this\.basePath\([^)]*\)\}/g, "/api/tickets")}\n${code.replace(/\$\{this\.basePath\([^)]*\)\}/g, "/api/backlog")}`;
      for (const m of code.matchAll(/\.(\w+)\.(\w+)\.(\w+)\(/g)) {
        const k = `${m[1]}.${m[2]}.${m[3]}`;
        if (known.has(k)) methods.add(k);
      }
      for (const m of code.matchAll(/\.(\w+)\.(\w+)\(/g)) {
        const k = `${m[1]}.${m[2]}`;
        if (known.has(k)) methods.add(k);
      }
      // Un gruppo passato INTERO (`fromClient(appClient().automations)`, un alias
      // `const c = appClient().mail;`): tutti i suoi metodi contano come usati.
      // Sovrastima, ma dalla parte giusta: si toglie di meno, mai di più.
      for (const m of code.matchAll(/appClient\(\)\.(\w+)(?!\s*\.\s*\w+\s*\(|\w)/g)) {
        for (const k of known.keys()) if (k.startsWith(`${m[1]}.`)) methods.add(k);
      }
      for (const c of callsIn(code)) literals.push({ ...c, file });
    }
  }
  return { methods, literals };
}

// --- 4. il rapporto --------------------------------------------------------------

const EXTERNAL = new Set(["inbound", "infra", "login", "stream", "desktop_link", "session_only", "secret_once", "chat_tool", "vault"]);

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const jsonIdx = args.indexOf("--json");
  const all = await routes();
  const clientMethods = apiClientMethods();
  const used = callers(clientMethods);
  // Solo per le note (NON contano come chiamanti, D4): i tool dedicati
  // dell'MCP (`packages/mcp/src`, compresi i flussi del plugin) e la mobile di oggi.
  const hits = (c: Callers) => (r: Route) =>
    c.literals.some((l) => l.norm === r.norm && (!l.method || l.method === r.method)) ||
    [...c.methods].some((k) => (clientMethods.get(k) ?? []).some((x) => x.norm === r.norm && (!x.method || x.method === r.method)));
  const byMcpTools = hits(callers(clientMethods, ["packages/mcp/src"]));
  const byMobile = hits(callers(clientMethods, ["apps/mobile/src"]));
  // Un percorso che il SERVER scrive in una risposta (`avatarUrl`, `imagePath`,
  // un link): il client lo usa così com'è, quindi non si vede come chiamata.
  const byServerData = hits(callers(clientMethods, ["apps/server/src", "packages/notifications/src", "packages/shared/src"]));

  const viaClient = new Map<string, Set<string>>(); // `METHOD norm` → metodi che la chiamano
  for (const key of used.methods) {
    for (const c of clientMethods.get(key) ?? []) {
      for (const r of all) {
        if (r.norm !== c.norm || (c.method && c.method !== r.method)) continue;
        const k = `${r.method} ${r.url}`;
        viaClient.set(k, (viaClient.get(k) ?? new Set()).add(key));
      }
    }
  }
  const viaLiteral = new Map<string, Set<string>>();
  for (const c of used.literals) {
    for (const r of all) {
      if (r.norm !== c.norm || (c.method && c.method !== r.method)) continue;
      const k = `${r.method} ${r.url}`;
      viaLiteral.set(k, (viaLiteral.get(k) ?? new Set()).add(c.file));
    }
  }

  const rows = all.map((r) => {
    const k = `${r.method} ${r.url}`;
    const client = [...(viaClient.get(k) ?? [])];
    const literal = [...(viaLiteral.get(k) ?? [])];
    // Un letterale senza verbo (un percorso restituito o passato) è un dubbio, non una chiamata certa.
    const literalWithVerb = used.literals.some((c) => c.method === r.method && c.norm === r.norm);
    const external = r.exclude !== null && EXTERNAL.has(r.exclude);
    const status =
      client.length > 0 || literalWithVerb ? "usata" : external ? "esterna" : literal.length > 0 || byServerData(r) ? "dubbio" : "senza chiamanti";
    return { ...r, key: k, client, literal, status, mcpTool: byMcpTools(r), mobile: byMobile(r) };
  });

  const by = (s: string) => rows.filter((r) => r.status === s);
  const unused = by("senza chiamanti");
  const doubt = by("dubbio");
  const external = by("esterna");
  const lines: string[] = [];
  lines.push("# Rotte del server contro i chiamanti dell'app");
  lines.push("");
  lines.push(`Generato da \`apps/server/scripts/route-callers.ts\`. Rotte: ${rows.length}; usate dall'app: ${by("usata").length}; esterne per dichiarazione: ${external.length}; dubbi: ${doubt.length}; **senza chiamanti: ${unused.length}**.`);
  lines.push("");
  const base = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo }).toString().trim();
  lines.push(`Base: \`${base}\`. Un ramo non ancora unito che chiama una rotta (la cassaforte nel browser, il grafo, le PR aperte) qui non si vede: lo script si rilancia sulla base del taglio.`);
  lines.push("");
  lines.push("L'MCP non conta come chiamante (D4). Ogni riga è da rivedere a mano prima di togliere la rotta.");
  const table = (title: string, list: typeof rows, extra: (r: (typeof rows)[number]) => string) => {
    lines.push("", `## ${title} (${list.length})`, "", "| Rotta | Azione MCP | Note |", "|---|---|---|");
    for (const r of list) lines.push(`| \`${r.key}\` | ${r.mcp} | ${extra(r)} |`);
  };
  const notes = (r: (typeof rows)[number]) =>
    [r.mcpTool ? "⚠️ la usano i tool dedicati dell'MCP" : "", r.mobile ? "mobile di oggi" : ""].filter(Boolean).join("; ");
  const mcpCritical = unused.filter((r) => r.mcpTool);
  lines.push("", `Di quelle senza chiamanti, **${mcpCritical.length} le usano i tool dedicati dell'MCP** (\`packages/mcp/src\`, compresi i flussi dei comandi del plugin): toglierle rompe quei tool, quindi o il tool passa a una rotta dell'app o la rotta resta. ${unused.filter((r) => r.mobile).length} le usa la mobile di oggi (D5: si accetta).`);
  table("Senza chiamanti: da togliere", unused, notes);
  table("Dubbi: il percorso compare nel codice dell'app o in una risposta del server, senza una chiamata tracciata", doubt, (r) =>
    r.literal.length > 0 ? r.literal.map((f) => `\`${f}\``).join(", ") : "scritto dal server in una risposta",
  );
  table("Esterne per dichiarazione (restano, salvo decisione)", external, (r) => `exclude: ${r.exclude}`);
  const report = lines.join("\n") + "\n";
  if (outIdx >= 0) writeFileSync(args[outIdx + 1]!, report);
  else process.stdout.write(report);
  if (jsonIdx >= 0) writeFileSync(args[jsonIdx + 1]!, JSON.stringify(rows, null, 2));
  process.stderr.write(`rotte ${rows.length}, usate ${by("usata").length}, esterne ${external.length}, dubbi ${doubt.length}, senza chiamanti ${unused.length}\n`);
  process.exit(0);
}

void main();
