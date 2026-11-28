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
 *     widget, dell'agente di monitoraggio, dell'SDK e del worker (la chat di
 *     Claude legge il server col token del turno, solo GET), le chiamate
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

/**
 * Un percorso chiamato contro quello di una rotta: uguali, oppure uguali salvo
 * i segmenti VARIABILI della chiamata (\`/api/tickets/${id}/${field}\` → \`:/:\`),
 * che valgono qualunque segmento della rotta (\`/design\`, \`/plan\`). Il secondo
 * caso è «wild», e vale SOLO per una chiamata col verbo e se nessuna rotta con quel verbo ha esattamente
 * il percorso della chiamata: \`/api/projects/${id}\` è \`/:projectId\`, non
 * \`/pulse\`. Sovrastima dalla parte giusta (si toglie di meno), e il rapporto
 * lo dice in una sezione a sé.
 */
const exactRoutes = new Set<string>(); // `METHOD norm`, riempito da `routes()`
function pathMatch(call: string, route: string, method: string | null): "exact" | "wild" | null {
  if (call === route) return "exact";
  // Senza verbo (un percorso che compare, non una chiamata) solo l'uguaglianza:
  // \`/api/tickets/${id}/${x}\` varrebbe ogni rotta a due segmenti.
  if (method === null || exactRoutes.has(`${method} ${call}`)) return null;
  const c = call.split("/");
  const r = route.split("/");
  if (c.length !== r.length) return null;
  for (let i = 0; i < c.length; i++) if (c[i] !== r[i] && c[i] !== ":") return null;
  return "wild";
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
  for (const r of seen.values()) exactRoutes.add(`${r.method} ${r.norm}`);
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

/**
 * I percorsi chiamati in un pezzo di codice: `request("VERB", path)` (o
 * un'altra funzione col verbo per primo: `one(…)` dell'api-client, `call(…)`
 * del main del Mac) e i letterali `/api/…`.
 */
function callsIn(source: string): { method: string | null; norm: string }[] {
  const out: { method: string | null; norm: string }[] = [];
  const code = collapseInterpolations(source);
  const req = /\b\w+(?:<[^>]*>)?\(\s*["'](GET|POST|PUT|PATCH|DELETE)["']\s*,\s*([`"'])([^`"']*?)\2/g;
  for (const m of code.matchAll(req)) out.push({ method: m[1]!, norm: normalize(m[3]!) });
  // Anche con l'origine davanti (`${instance}/api/…`, il main del Mac).
  const literal = /([`"'])(?:\$\{[^}]*\})?(\/(?:api|widget|ingest|monitor|webhooks|go)\/[^`"'\s]*)\1/g;
  for (const m of code.matchAll(literal)) out.push({ method: null, norm: normalize(m[2]!) });
  return out;
}

/**
 * Le interpolazioni `${…}` ridotte a `${_}`: dentro possono esserci virgolette
 * (`${toQuery({ ids: ids.join(",") })}`) che troncherebbero il percorso.
 * `normalize` le legge poi come segmento o come query.
 */
function collapseInterpolations(code: string): string {
  let out = "";
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "$" && code[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      for (; j < code.length && depth > 0; j++) {
        if (code[j] === "{") depth++;
        else if (code[j] === "}") depth--;
      }
      out += "${_}";
      i = j - 1;
      continue;
    }
    out += code[i];
  }
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
  // Anche un aiuto costruito su un altro (`const run = (c, n) => \`${base(c)}/runs/${n}\``):
  // i passaggi sotto lo espandono a catena.
  for (const m of from.matchAll(/const (\w+)\s*=\s*\([^)]*\)(?:\s*:\s*\w+)?\s*=>\s*([`"'])(\/[^`"']*|\$\{\w+(?:\([^)]*\))?\}\/[^`"']*)\2/g)) helpers.set(m[1]!, m[3]!);
  for (const m of from.matchAll(/const (\w+)\s*=\s*([`"'])(\/[^`"']*|\$\{\w+(?:\([^)]*\))?\}\/[^`"']*)\2/g)) helpers.set(m[1]!, m[3]!);
  let out = code;
  // L'aiuto passato NUDO come percorso (`request("GET", base(code))`,
  // `request("GET", SECURITY)`): diventa il suo template.
  for (const [name, template] of helpers)
    out = out.replace(
      new RegExp(`(\\(\\s*["'](?:GET|POST|PUT|PATCH|DELETE)["']\\s*,\\s*)${name}(?:\\([^()]*\\))?(?=\\s*[,)])`, "g"),
      (_, head: string) => `${head}\`${template}\``,
    );
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
      // Le funzioni locali della fabbrica (\`function act(…)\` a 2 spazi, prima
      // del \`return {\`): un metodo che le nomina (\`act,\`, \`answer() { return
      // act(…) }\`) chiama i loro percorsi.
      const locals = new Map<string, { method: string | null; norm: string }[]>();
      for (const m of body.matchAll(/^ {2}(?:async\s+)?function (\w+)\s*(?:<[^>]*>)?\(([\s\S]*?)^ {2}\}/gm)) locals.set(m[1]!, callsIn(m[2]!));
      const viaLocals = (text: string) =>
        [...locals].flatMap(([name, calls]) => (new RegExp(`(^|[^\\w.])${name}\\s*(\\(|,\\s*$)`, "m").test(text) ? calls : []));
      // I metodi: righe a 4 spazi `nome(` o `async nome(`, o una funzione locale
      // messa nell'oggetto (\`act,\` / \`decide: act,\`); un sotto-oggetto `nome: {` dà `gruppo.nome.metodo`.
      const lines = body.slice(Math.max(0, body.search(/^ {2}return \{/m))).split("\n");
      let current: string | null = null;
      let sub: string | null = null;
      let chunk: string[] = [];
      const flush = () => {
        if (current) {
          const key = sub ? `${group}.${sub}.${current}` : `${group}.${current}`;
          const text = chunk.join("\n");
          out.set(key, [...(out.get(key) ?? []), ...callsIn(text), ...viaLocals(text.replace(/^\s*\w+:\s*/, ""))]);
        }
        chunk = [];
      };
      for (const line of lines) {
        const top = /^ {4}(?:async\s+)?(\w+)\s*(?:<[^>]*>)?\(/.exec(line) ?? /^ {4}(\w+)(?::\s*\w+)?,\s*$/.exec(line);
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
  // Il worker chiama il server: la chat di Claude (`claude-chat/`) legge col
  // token del turno. Senza, `GET /api/projects/pulse` risultava da togliere (R2).
  "apps/worker/src",
];

/**
 * Le radici dove un percorso scritto senza verbo è una LETTURA: la chat di
 * Claude nel worker elenca i percorsi che legge (`bridge.ts`), e il token del
 * turno accetta solo GET (`apps/server/src/auth/chat-tool-routes.ts`, provato da `chat-tool-token.test.ts`).
 */
const GET_ONLY_ROOTS = ["apps/worker/src/claude-chat/"];

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
      const getOnly = GET_ONLY_ROOTS.some((r) => file.startsWith(r));
      for (const c of callsIn(code)) literals.push({ ...c, method: c.method ?? (getOnly ? "GET" : null), file });
    }
  }
  return { methods, literals };
}

// --- 4. il rapporto --------------------------------------------------------------

const EXTERNAL = new Set(["inbound", "infra", "login", "stream", "desktop_link", "session_only", "secret_once", "chat_tool", "vault"]);

/**
 * Ogni rotta del server col suo esito: «usata», «esterna», «dubbio» o «senza
 * chiamanti», e chi la chiama. Il rapporto (`main`) e il test la leggono da qui.
 */
export async function classifyRoutes() {
  const all = await routes();
  const clientMethods = apiClientMethods();
  const used = callers(clientMethods);
  // Solo per le note (NON contano come chiamanti, D4): i tool dedicati
  // dell'MCP (`packages/mcp/src`, compresi i flussi del plugin) e la mobile di oggi.
  const hits = (c: Callers) => (r: Route) =>
    c.literals.some((l) => pathMatch(l.norm, r.norm, l.method) && (!l.method || l.method === r.method)) ||
    [...c.methods].some((k) => (clientMethods.get(k) ?? []).some((x) => pathMatch(x.norm, r.norm, x.method) && (!x.method || x.method === r.method)));
  const byMcpTools = hits(callers(clientMethods, ["packages/mcp/src"]));
  const byMobile = hits(callers(clientMethods, ["apps/mobile/src"]));
  // Un percorso che il SERVER scrive in una risposta (`avatarUrl`, `imagePath`,
  // un link): il client lo usa così com'è, quindi non si vede come chiamata.
  const byServerData = hits(callers(clientMethods, ["apps/server/src", "packages/notifications/src", "packages/shared/src"]));

  const wild = new Set<string>(); // rotte raggiunte SOLO da un segmento variabile
  const exact = new Set<string>();
  const viaClient = new Map<string, Set<string>>(); // `METHOD norm` → metodi che la chiamano
  for (const key of used.methods) {
    for (const c of clientMethods.get(key) ?? []) {
      for (const r of all) {
        const how = pathMatch(c.norm, r.norm, c.method);
        if (!how || (c.method && c.method !== r.method)) continue;
        const k = `${r.method} ${r.url}`;
        (how === "exact" ? exact : wild).add(k);
        viaClient.set(k, (viaClient.get(k) ?? new Set()).add(key));
      }
    }
  }
  const viaLiteral = new Map<string, Set<string>>();
  for (const c of used.literals) {
    for (const r of all) {
      const how = pathMatch(c.norm, r.norm, c.method);
      if (!how || (c.method && c.method !== r.method)) continue;
      const k = `${r.method} ${r.url}`;
      if (c.method) (how === "exact" ? exact : wild).add(k);
      viaLiteral.set(k, (viaLiteral.get(k) ?? new Set()).add(c.file));
    }
  }

  const rows = all.map((r) => {
    const k = `${r.method} ${r.url}`;
    const client = [...(viaClient.get(k) ?? [])];
    const literal = [...(viaLiteral.get(k) ?? [])];
    // Un letterale senza verbo (un percorso restituito o passato) è un dubbio, non una chiamata certa.
    const literalWithVerb = used.literals.some((c) => c.method === r.method && pathMatch(c.norm, r.norm, c.method));
    const external = r.exclude !== null && EXTERNAL.has(r.exclude);
    const status =
      client.length > 0 || literalWithVerb ? "usata" : external ? "esterna" : literal.length > 0 || byServerData(r) ? "dubbio" : "senza chiamanti";
    const onlyWild = status === "usata" && wild.has(k) && !exact.has(k);
    return { ...r, key: k, client, literal, status, onlyWild, mcpTool: byMcpTools(r), mobile: byMobile(r) };
  });
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const jsonIdx = args.indexOf("--json");
  const rows = await classifyRoutes();

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
  table("Usate solo attraverso un segmento variabile (\`…/${field}\`): da confermare che la chiamata le raggiunga", by("usata").filter((r) => r.onlyWild), (r) =>
    [...r.client.map((m) => `\`${m}\``), ...r.literal.map((f) => `\`${f}\``)].join(", "),
  );
  table("Esterne per dichiarazione (restano, salvo decisione)", external, (r) => `exclude: ${r.exclude}`);
  const report = lines.join("\n") + "\n";
  if (outIdx >= 0) writeFileSync(args[outIdx + 1]!, report);
  else process.stdout.write(report);
  if (jsonIdx >= 0) writeFileSync(args[jsonIdx + 1]!, JSON.stringify(rows, null, 2));
  process.stderr.write(`rotte ${rows.length}, usate ${by("usata").length}, esterne ${external.length}, dubbi ${doubt.length}, senza chiamanti ${unused.length}\n`);
  process.exit(0);
}

// Solo da riga di comando: il test importa `classifyRoutes` senza scrivere il rapporto.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
