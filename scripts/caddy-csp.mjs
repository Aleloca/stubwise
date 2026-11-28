// La CSP dell'origine (indurimento di sicurezza, nota della cassaforte nel
// browser §1-2, C1/M1). Caddy la manda come HEADER, mai come <meta> (un <meta>
// lo toglie chi controlla il documento), su tutte le pagine statiche
// dell'origine: la nuova app (/, da R1) e la guida (/guide).
// Le risposte del server (/api, il widget, la vista del grafo) hanno le loro.
//
// Questo modulo fa due cose, e le fa nel build dell'immagine caddy
// (Dockerfile.caddy), dove ci sono i bundle veri:
//   1. CONTROLLA che la nuova app non abbia script inline
//      (con `script-src 'self'` non girerebbero: la pagina si romperebbe in
//      produzione, non nei test). Un attributo `on*=` è uno script inline.
//   2. GENERA la direttiva della guida: Starlight scrive script inline (il tema,
//      la barra laterale, le schede), quindi la guida li ammette PER HASH, uno
//      per uno, mai con `'unsafe-inline'`. Il file generato è un frammento
//      Caddy importato dal blocco /guide del Caddyfile.
//
//   node scripts/caddy-csp.mjs --app <dir> --vault <dir> --docs <dir> --out <file>

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * La base, uguale per tutte le pagine statiche:
 * - `script-src 'self'`: niente inline, niente `eval`;
 * - `object-src 'none'` e `base-uri 'none'`;
 * - `frame-ancestors 'none'`: nessuno ci incornicia (l'app non si mette in
 *   un iframe; la vista del grafo è una risposta del server);
 * - `connect-src 'self'`: fetch, XHR, EventSource e WebSocket solo verso
 *   l'origine (gli scaricamenti presigned sono navigazioni o <img>, non fetch).
 * Immagini, font e stili restano liberi: le mail in UntrustedHtmlFrame (un
 * iframe `srcdoc` sandbox senza script, che EREDITA questa CSP) mostrano
 * immagini remote, e la loro CSP stretta la mette il frame stesso.
 */
export const BASE_DIRECTIVES = ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "connect-src 'self'"];

/**
 * La pagina A SÉ della cassaforte (`/app/vault/`, revisione di sicurezza
 * della fase 2, I-2): una CSP sua, più stretta di quella dell'origine (tutto
 * chiuso salvo l'origine stessa per script, stili, immagini, font, rete e il
 * worker; nessun form, nessuna cornice, nessun `<base>`), e i Trusted Types
 * con la SOLA politica del worker: lì non si scrive HTML.
 */
export const VAULT_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types stubwise-vault-worker",
].join("; ");

/**
 * La COOP della pagina a sé (seconda revisione di sicurezza della fase 2,
 * I-1): `same-origin` non separa una pagina della STESSA origine, e uno script
 * nell'app che apre `/app/vault/` (o ne segue la scheda) la governerebbe
 * prima del boot. `noopener-allow-popups` chiude il riferimento in Chromium
 * (`apps/desktop/scripts/verify-vault-isolation.mjs`). Dove il valore non è
 * supportato resta il comportamento di `unsafe-none`: la difesa vera è
 * un'origine separata (registro dei rimandi).
 */
export const VAULT_PAGE_COOP = "noopener-allow-popups";

export function cspHeader(scriptSources) {
  return [`script-src ${["'self'", ...scriptSources].join(" ")}`, ...BASE_DIRECTIVES].join("; ");
}

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return htmlFiles(full);
    return name.endsWith(".html") ? [full] : [];
  });
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
/** I tipi di <script> che il browser NON esegue (dati: JSON, JSON-LD, mappe d'import di sola lettura no). */
const DATA_TYPES = new Set(["application/json", "application/ld+json", "text/template"]);

/** Gli script inline ESEGUIBILI di un HTML, e gli attributi `on*=` (anche loro inline). */
export function inlineScripts(html) {
  const bodies = [];
  for (const [, attrs, body] of html.matchAll(SCRIPT)) {
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = /\btype\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && DATA_TYPES.has(type)) continue;
    bodies.push(body);
  }
  const handlers = [...html.matchAll(/<[a-z][^>]*\son[a-z]+\s*=/gi)].length;
  return { bodies, handlers };
}

export const sha256 = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/** Gli hash distinti degli script inline di una cartella di HTML. */
export function inlineHashes(dir) {
  const hashes = new Set();
  let handlers = 0;
  for (const file of htmlFiles(dir)) {
    const found = inlineScripts(readFileSync(file, "utf8"));
    for (const body of found.bodies) hashes.add(sha256(body));
    handlers += found.handlers;
  }
  return { hashes: [...hashes].sort(), handlers };
}

/** Il frammento Caddy della guida: la base, gli hash di Starlight, e WebAssembly per Pagefind. */
export function guideSnippet(hashes) {
  // `'wasm-unsafe-eval'` sblocca SOLO la compilazione di WebAssembly (la
  // ricerca di Pagefind), non `eval` né `new Function`.
  return `# GENERATO da scripts/caddy-csp.mjs nel build dell'immagine caddy: non modificarlo a mano.\nheader Content-Security-Policy "${cspHeader(["'wasm-unsafe-eval'", ...hashes])}"\n`;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

// Lanciato come script (non importato dal test): il confronto passa per un URL
// vero, così regge spazi, caratteri da codificare e symlink nel percorso.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { app, vault, docs, out } = args(process.argv.slice(2));
  const problems = [];
  for (const [name, dir] of [["app", app], ["vault", vault]]) {
    if (!dir) {
      problems.push(`${name}: cartella mancante (--${name})`);
      continue;
    }
    const { hashes, handlers } = inlineHashes(dir);
    if (hashes.length > 0 || handlers > 0) problems.push(`${name} (${dir}): ${hashes.length} script inline e ${handlers} attributi on*= — con script-src 'self' non girano`);
  }
  if (problems.length > 0) {
    console.error(`CSP: ${problems.join("; ")}`);
    process.exit(1);
  }
  const guide = inlineHashes(docs);
  if (guide.handlers > 0) {
    console.error(`CSP: la guida ha ${guide.handlers} attributi on*= (un hash non li copre)`);
    process.exit(1);
  }
  writeFileSync(out, guideSnippet(guide.hashes));
  console.log(`CSP: app senza script inline; guida con ${guide.hashes.length} hash -> ${out}`);
}
