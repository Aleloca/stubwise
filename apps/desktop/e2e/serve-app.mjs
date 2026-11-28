/*
 * La build web VERA della nuova app (`dist-web`, `pnpm build:web`) servita
 * come in produzione: su `/app/`, con le intestazioni che Caddy le dà, e il
 * proxy di `/api/*` verso il server della suite (`start-stack.mjs`, :3220).
 *
 * Le intestazioni NON sono copiate a mano: si leggono dal Caddyfile della
 * radice (lo snippet `csp_strict` e le righe `header` del blocco
 * `handle_path /app/*`), così quando cambiano lì cambiano anche qui.
 * `index.html` (e il fallback) `no-store`, gli asset no, come `@appDocument`.
 */
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import process from "node:process";

const here = import.meta.dirname;
const DIST = resolve(here, "../dist-web");
/** La pagina a sé della cassaforte (`pnpm build:vault`), su `/app/vault/` come la serve Caddy. */
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

/**
 * Le intestazioni della pagina a sé della cassaforte: il SUO blocco del
 * Caddyfile (`handle_path /app/vault/*`), con la sua CSP sola (niente
 * `csp_strict`) e la sua COOP.
 */
export async function vaultHeaders(caddyfilePath = resolve(here, "../../../Caddyfile")) {
  const text = await readFile(caddyfilePath, "utf8");
  const vault = block(text, "handle_path /app/vault/* {");
  if (/import\s+csp_strict/.test(vault)) throw new Error("Caddyfile: /app/vault ha una CSP sola, la sua");
  const headers = {};
  for (const { name, value } of headerLines(vault)) headers[name] = value;
  if (!headers["content-security-policy"]) throw new Error("Caddyfile: /app/vault senza CSP");
  return headers;
}

export async function appHeaders(caddyfilePath = resolve(here, "../../../Caddyfile")) {
  const text = await readFile(caddyfilePath, "utf8");
  const headers = {};
  const put = ({ add, name, value }) => {
    if (add && headers[name]) headers[name] = [].concat(headers[name], value);
    else headers[name] = value;
  };
  for (const h of headerLines(block(text, "(csp_strict) {"))) put(h);
  const app = block(text, "handle_path /app/* {");
  if (!/import\s+csp_strict/.test(app)) throw new Error("Caddyfile: /app non importa csp_strict");
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
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path.startsWith("/api/")) return proxy(req, res);
    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (path === "/app" || path === "/app/vault") {
      res.writeHead(308, { location: `${path}/` });
      res.end();
      return;
    }
    // Prima di /app, come in Caddy.
    if (path.startsWith("/app/vault/")) return serveStatic(res, path, "/app/vault/", VAULT_DIST, "vault.html", vault);
    if (!path.startsWith("/app/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    return serveStatic(res, path, "/app/", DIST, "index.html", headers);
  });
  server.listen(PORT, () => console.log(`[e2e app] /app su :${PORT}, /api → ${API.origin}`));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
