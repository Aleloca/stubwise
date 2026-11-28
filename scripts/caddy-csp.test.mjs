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
import { BASE_DIRECTIVES, cspHeader, guideSnippet, inlineHashes, inlineScripts, sha256 } from "./caddy-csp.mjs";

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

  it("il Dockerfile di caddy genera il frammento della guida e lo copia dove il Caddyfile lo importa", () => {
    const docker = readFileSync(join(here, "..", "Dockerfile.caddy"), "utf8");
    assert.match(docker, /RUN node scripts\/caddy-csp\.mjs --app apps\/desktop\/dist-web --docs apps\/docs\/dist --out \/repo\/csp-guide\.caddy/);
    assert.match(docker, /COPY --from=static-build \/repo\/csp-guide\.caddy \/etc\/caddy\/csp-guide\.caddy/);
    assert.match(docker, /COPY --from=static-build \/repo\/apps\/desktop\/dist-web \/srv\/app/);
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
    const run = (app) => spawnSync(process.execPath, [join(here, "caddy-csp.mjs"), "--app", app, "--docs", docs, "--out", out], { encoding: "utf8" });
    assert.equal(run(dirty).status, 1);
    assert.equal(run(clean).status, 0);
    assert.ok(readFileSync(out, "utf8").includes(sha256("theme()")));
    assert.equal(inlineHashes(docs).hashes.length, 1);
  });
});
