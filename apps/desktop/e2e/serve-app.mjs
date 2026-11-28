/*
 * La build web VERA della nuova app (`dist-web`, `pnpm build:web`) servita
 * come in produzione: alla RADICE (R1), con le intestazioni che Caddy le dà,
 * la pagina a sé della cassaforte su `/vault/`, e il proxy di `/api/*` verso
 * il server della suite (`start-stack.mjs`, :3220).
 *
 * Intestazioni e rimandi NON sono copiati a mano: si leggono dal Caddyfile
 * della radice (lo snippet `csp_strict`, le righe `header` del `handle` della
 * radice e di `handle_path /vault/*`, le righe `redir`), così quando cambiano
 * lì cambiano anche qui. `index.html` (e il fallback) `no-store`, gli asset
 * no, come `@appDocument`.
 */
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import process from "node:process";

const here = import.meta.dirname;
const DIST = resolve(here, "../dist-web");
/** La pagina a sé della cassaforte (`pnpm build:vault`), su `/vault/` come la serve Caddy. */
const VAULT_DIST = resolve(here, "../dist-vault");
const PORT = Number(process.env.E2E_APP_PORT ?? 5220);
const API = new URL(process.env.E2E_API_TARGET ?? "http://localhost:3220");

/** Il corpo del blocco del Caddyfile che inizia con `opener`, fino alla graffa che lo chiude. */
function block(text, opener) {
  const start = text.indexOf(opener);
  if (start < 0) throw new Error(`Caddyfile: blocco «${opener}» assente`);
  let depth = 0;
  for (let i = text.indexOf("{", start + opener.length - 1); i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`Caddyfile: blocco «${opener}» non chiuso`);
}

/** Le righe `header [+]Nome "valore"` (senza matcher) di un blocco, in ordine. */
function headerLines(body) {
  const code = body.replace(/#.*$/gm, "");
  return [...code.matchAll(/^\s*header\s+(\+?)([A-Za-z-]+)\s+"([^"]*)"\s*$/gm)].map((m) => ({
    add: m[1] === "+",
    name: m[2].toLowerCase(),
    value: m[3],
  }));
}

const CADDYFILE = resolve(here, "../../../Caddyfile");

/**
 * Le intestazioni della pagina a sé della cassaforte: il SUO blocco del
 * Caddyfile (`handle_path /vault/*`), con la sua CSP sola (niente
 * `csp_strict`) e la sua COOP.
 */
export async function vaultHeaders(caddyfilePath = CADDYFILE) {
  const text = await readFile(caddyfilePath, "utf8");
  const vault = block(text, "handle_path /vault/* {");
  if (/import\s+csp_strict/.test(vault)) throw new Error("Caddyfile: /vault ha una CSP sola, la sua");
  const headers = {};
  for (const { name, value } of headerLines(vault)) headers[name] = value;
  if (!headers["content-security-policy"]) throw new Error("Caddyfile: /vault senza CSP");
  return headers;
}

/** Il `handle {` senza matcher: l'app alla radice (l'ultimo blocco del sito). */
function rootHandle(text) {
  const m = /^\thandle \{$/m.exec(text);
  if (!m) throw new Error("Caddyfile: il `handle` della radice è assente");
  return block(text.slice(m.index), "handle {");
}

/**
 * I rimandi del Caddyfile, nell'ordine: `redir <percorso> <dove> <codice>`
 * (percorso esatto) e `redir @nome …` col suo `@nome path <percorso>`. Il
 * `{query}` si sostituisce con la query della richiesta.
 */
export async function redirects(caddyfilePath = CADDYFILE) {
  // Un commento comincia a inizio riga o dopo uno spazio: `/vault/#/pair` non lo è.
  const text = (await readFile(caddyfilePath, "utf8")).replace(/(^|\s)#.*$/gm, "$1");
  const matchers = new Map([...text.matchAll(/^\s*@(\w+)\s+path\s+(\S+)\s*$/gm)].map((m) => [m[1], m[2]]));
  const out = [];
  for (const m of text.matchAll(/^\s*redir\s+(\S+)\s+(\S+)\s+(\d{3})\s*$/gm)) {
    if (m[1] === "*") continue; // quello di /app/*, controllato sotto
    const path = m[1].startsWith("@") ? matchers.get(m[1].slice(1)) : m[1];
    if (!path || path.includes("*")) throw new Error(`Caddyfile: redir ${m[1]} non riconosciuto`);
    out.push({ path, to: m[2], status: Number(m[3]) });
  }
  // /app/* porta al posto nuovo togliendo il prefisso (`handle_path` + `redir * {uri}`).
  if (!/handle_path \/app\/\* \{\s*redir \* \{uri\} 308\s*\}/.test(text)) throw new Error("Caddyfile: il rimando di /app/* è cambiato");
  return out;
}

export async function appHeaders(caddyfilePath = CADDYFILE) {
  const text = await readFile(caddyfilePath, "utf8");
  const headers = {};
  const put = ({ add, name, value }) => {
    if (add && headers[name]) headers[name] = [].concat(headers[name], value);
    else headers[name] = value;
  };
  for (const h of headerLines(block(text, "(csp_strict) {"))) put(h);
  const app = rootHandle(text);
  if (!/import\s+csp_strict/.test(app)) throw new Error("Caddyfile: la radice non importa csp_strict");
  for (const h of headerLines(app)) put(h);
  return headers;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function proxy(req, res) {
  const out = httpRequest(
    { host: API.hostname, port: API.port, method: req.method, path: req.url, headers: { ...req.headers, host: `${API.hostname}:${API.port}` } },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  out.on("error", () => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end('{"code":"bad_gateway"}');
  });
  req.pipe(out);
}

/** Un file statico di `dist` sotto `prefix`, col fallback di `try_files {path} /<fallback>` e `no-store` fuori da `assets/`. */
async function serveStatic(res, path, prefix, dist, fallback, headers) {
  const rel = normalize(path.slice(prefix.length)).replace(/^(\.\.[/\\])+/, "");
  let file = join(dist, rel);
  let body;
  try {
    body = rel && extname(rel) ? await readFile(file) : null;
  } catch {
    body = null;
  }
  if (!body) {
    file = join(dist, fallback);
    body = await readFile(file);
  }
  const isAsset = path.startsWith(`${prefix}assets/`);
  res.writeHead(200, {
    ...headers,
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    ...(isAsset ? {} : { "cache-control": "no-store" }),
  });
  res.end(body);
}

async function main() {
  const headers = await appHeaders();
  const vault = await vaultHeaders();
  const redirs = await redirects();
  const server = createServer(async (req, res) => {
    const [path, query = ""] = (req.url ?? "/").split("?");
    const send = (status, location) => {
      res.writeHead(status, { location });
      res.end();
    };
    if (path.startsWith("/api/")) return proxy(req, res);
    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    const r = redirs.find((x) => x.path === path);
    if (r) return send(r.status, r.to.replace("{query}", query));
    // Prima della radice, come in Caddy.
    if (path.startsWith("/vault/")) return serveStatic(res, path, "/vault/", VAULT_DIST, "vault.html", vault);
    if (path.startsWith("/app/")) return send(308, path.slice("/app".length) + (query ? `?${query}` : ""));
    return serveStatic(res, path, "/", DIST, "index.html", headers);
  });
  server.listen(PORT, () => console.log(`[e2e app] alla radice su :${PORT}, /vault/, /api → ${API.origin}`));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
