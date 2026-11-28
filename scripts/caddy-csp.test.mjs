// node --test scripts/caddy-csp.test.mjs
//
// La CSP dell'origine (indurimento di sicurezza, C1/M1): il Caddyfile manda
// gli header giusti sulle pagine statiche e NON sulle risposte del server, e il
// controllo del build ferma gli script inline. La prova che il browser non
// registra violazioni sui bundle veri (Playwright su un caddy locale) è nella
// voce del deploy-log; qui c'è ciò che si può tenere vero in CI.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { BASE_DIRECTIVES, VAULT_PAGE_COOP, VAULT_PAGE_CSP, cspHeader, guideSnippet, inlineHashes, inlineScripts, sha256 } from "./caddy-csp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const caddyfile = readFileSync(join(here, "..", "Caddyfile"), "utf8");
const root = mkdtempSync(join(tmpdir(), "caddy-csp-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Il corpo di un blocco del Caddyfile che inizia con `opener` (fino alla graffa che lo chiude). */
function block(opener) {
  const start = caddyfile.indexOf(opener);
  assert.ok(start >= 0, `blocco «${opener}» assente dal Caddyfile`);
  let depth = 0;
  for (let i = caddyfile.indexOf("{", start); i < caddyfile.length; i++) {
    if (caddyfile[i] === "{") depth++;
    if (caddyfile[i] === "}" && --depth === 0) return caddyfile.slice(start, i + 1);
  }
  throw new Error(`blocco «${opener}» non chiuso`);
}

describe("il Caddyfile", () => {
  it("m-7: nessun Service Worker, un 403 a `Service-Worker: script` nel PRIMO handle del sito", () => {
    // Il sito dal suo inizio (la graffa di `{$DOMAIN}` confonderebbe `block`).
    const code = caddyfile.slice(caddyfile.indexOf("{$DOMAIN} {")).replace(/#.*$/gm, "");
    assert.match(code, /@serviceWorkerScript\s+header\s+Service-Worker\s+script/);
    assert.match(block("handle @serviceWorkerScript {"), /respond\s+403/);
    const firstHandle = /\bhandle(?:_path)?\s+(\S+)/.exec(code);
    assert.equal(firstHandle?.[1], "@serviceWorkerScript", "è il primo handle (i handle sono esclusivi)");
  });

  it("la CSP di base è quella dello script, senza unsafe-inline né unsafe-eval", () => {
    const snippet = block("(csp_strict)");
    assert.ok(snippet.includes(`header Content-Security-Policy "${cspHeader([])}"`), snippet);
    for (const d of ["script-src 'self'", ...BASE_DIRECTIVES]) assert.ok(snippet.includes(d), d);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(caddyfile.replace(/#.*$/gm, "")), "nessun unsafe-inline/unsafe-eval fuori dai commenti");
  });

  it("le pagine statiche la mandano: la nuova app alla radice (con COOP e index.html no-store), la guida (il frammento generato)", () => {
    const app = block("\thandle {");
    assert.ok(app.includes("root * /srv/app"), "l'app alla radice (R1)");
    assert.ok(app.includes("import csp_strict"));
    assert.ok(app.includes('header Cross-Origin-Opener-Policy "same-origin"'));
    assert.ok(app.includes("@appDocument not path /assets/*") && app.includes('header @appDocument Cache-Control "no-store"'));
    assert.ok(block("handle_path /guide/*").includes("import /etc/caddy/csp-guide.caddy"));
  });

  it("il web vecchio non c'è più: /app è un redirect permanente alla radice, e i percorsi vecchi vanno ai rimandi", () => {
    // Solo le righe di commento: un `#` dentro un indirizzo (`/#/preferences/…`) è un frammento.
    const live = caddyfile.replace(/^\s*#.*$/gm, "");
    assert.ok(!live.includes("/srv/web"), "nessun web vecchio servito");
    assert.match(live, /redir \/app \/ 308/);
    assert.ok(block("handle_path /app/*").includes("redir * {uri} 308"));
    assert.ok(block("handle @legacyById").includes("rewrite * /go{uri}"));
    assert.match(live, /redir \/settings\/security \/#\/preferences\/security 302/);
    assert.match(live, /redir \/inbox \/#\/home 302/);
  });

  it("le risposte del server e il widget NON la ricevono (il grafo si incornicia, il widget si incorpora sui siti dei clienti)", () => {
    for (const opener of ["handle @backend", "handle /widget.js"]) {
      const b = block(opener);
      assert.ok(!b.includes("Content-Security-Policy") && !b.includes("csp_strict"), opener);
    }
    // E nessuna CSP nell'header globale del sito.
    const global = block("\theader {");
    assert.ok(!global.includes("Content-Security-Policy"));
  });

  it("I-2: la pagina a sé della cassaforte ha la SUA CSP stretta, i Trusted Types del solo worker, COOP e no-store, PRIMA di /app", () => {
    assert.equal(
      VAULT_PAGE_CSP,
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types stubwise-vault-worker",
    );
    const vault = block("handle_path /vault/*");
    assert.ok(vault.includes(`header Content-Security-Policy "${VAULT_PAGE_CSP}"`), vault);
    assert.ok(!vault.includes("csp_strict"), "una CSP sola, la sua (non quella dell'origine)");
    // Seconda revisione, I-1: `same-origin` non separa una pagina della STESSA
    // origine (l'app che la apre o la segue). `noopener-allow-popups` sì.
    assert.equal(VAULT_PAGE_COOP, "noopener-allow-popups");
    assert.ok(vault.includes(`header Cross-Origin-Opener-Policy "${VAULT_PAGE_COOP}"`), vault);
    assert.ok(vault.includes("@vaultDocument not path /assets/*") && vault.includes('header @vaultDocument Cache-Control "no-store"'));
    assert.ok(vault.includes("root * /srv/vault") && vault.includes("try_files {path} /vault.html"));
    assert.match(caddyfile, /redir \/vault \/vault\/ 308/);
    // Con l'app alla radice (R1), la pagina a sé sta su /vault/, PRIMA del
    // fallback dell'app (i `handle` sono valutati in ordine): dopo, il
    // catch-all servirebbe l'index dell'app con la CSP dell'origine.
    assert.ok(caddyfile.indexOf("handle_path /vault/*") < caddyfile.indexOf("\thandle {"), "prima del catch-all dell'app");
    assert.ok(caddyfile.indexOf("handle_path /vault/*") < caddyfile.indexOf("handle_path /app/*"), "prima del redirect di /app/*");
    assert.ok(!caddyfile.includes("handle_path /app/vault/*"), "il vecchio /app/vault/ lo copre il redirect di /app/*");
    // I Mac di prima della fase 2 aprono /vault-pair?state=…: l'associazione
    // ora è una pagina della pagina a sé.
    assert.match(caddyfile, /@vaultPair path \/vault-pair\n\s*redir @vaultPair \/vault\/#\/pair\?\{query\} 302/);
  });

  it("il Dockerfile di caddy genera il frammento della guida e lo copia dove il Caddyfile lo importa", () => {
    const docker = readFileSync(join(here, "..", "Dockerfile.caddy"), "utf8");
    assert.match(docker, /RUN node scripts\/caddy-csp\.mjs --app apps\/desktop\/dist-web --vault apps\/desktop\/dist-vault --docs apps\/docs\/dist --out \/repo\/csp-guide\.caddy/);
    assert.match(docker, /COPY --from=static-build \/repo\/csp-guide\.caddy \/etc\/caddy\/csp-guide\.caddy/);
    assert.match(docker, /COPY --from=static-build \/repo\/apps\/desktop\/dist-web \/srv\/app/);
    assert.match(docker, /COPY --from=static-build \/repo\/apps\/desktop\/dist-vault \/srv\/vault/);
    assert.ok(!docker.replace(/#.*$/gm, "").includes("apps/web"), "il web vecchio non si builda più");
  });
});

describe("gli script inline", () => {
  it("conta gli eseguibili e gli attributi on*=, non quelli con src né i dati JSON", () => {
    const html = `<script src="/a.js"></script><script>a()</script><script type="module">b()</script>
      <script type="application/ld+json">{}</script><button onclick="x()">x</button>`;
    const found = inlineScripts(html);
    assert.deepEqual(found.bodies, ["a()", "b()"]);
    assert.equal(found.handlers, 1);
  });

  it("il frammento della guida ha la base, WebAssembly e gli hash; mai unsafe-inline", () => {
    const snippet = guideSnippet([sha256("a()")]);
    assert.ok(snippet.includes(cspHeader(["'wasm-unsafe-eval'", sha256("a()")])));
    assert.ok(!snippet.includes("unsafe-inline"));
  });

  it("il controllo del build: fallisce con uno script inline nell'app, passa e scrive gli hash della guida", () => {
    const dir = (name, html) => {
      const d = join(root, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "index.html"), html);
      return d;
    };
    const clean = dir("app-ok", `<script type="module" src="/x.js"></script>`);
    const dirty = dir("app-ko", `<script>inline()</script>`);
    const docs = dir("docs", `<script>theme()</script>`);
    const out = join(root, "guide.caddy");
    const run = (app, vault = clean) =>
      spawnSync(process.execPath, [join(here, "caddy-csp.mjs"), "--app", app, "--vault", vault, "--docs", docs, "--out", out], { encoding: "utf8" });
    // --vault è obbligatorio: senza, il build fallisce invece di saltare il controllo.
    assert.equal(spawnSync(process.execPath, [join(here, "caddy-csp.mjs"), "--app", clean, "--docs", docs, "--out", out], { encoding: "utf8" }).status, 1);
    assert.equal(run(dirty).status, 1);
    assert.equal(run(clean, dirty).status, 1, "anche la pagina a sé della cassaforte (I-2)");
    assert.equal(run(clean).status, 0);
    assert.ok(readFileSync(out, "utf8").includes(sha256("theme()")));
    assert.equal(inlineHashes(docs).hashes.length, 1);
  });
});
