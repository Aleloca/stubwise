#!/usr/bin/env node
// La pagina a sé della cassaforte non si governa dall'app (seconda revisione
// di sicurezza della fase 2, I-1, dai PoC della revisione): l'app (alla
// radice da R1) e `/vault/` sono la STESSA origine, e COOP `same-origin` non
// le separa. I percorsi vengono da `APP_ENTRY`, come quelli di Caddy.
// Uno script iniettato nell'app che apre la pagina (`window.open`) o segue la
// sua scheda quando va lì (`location.assign`) ne terrebbe un riferimento, e
// PRIMA del boot sostituirebbe `Worker.prototype.postMessage` e
// `addEventListener`: leggerebbe il kit nelle risposte del worker e nel DOM.
//
// Con COOP `noopener-allow-popups` sulla pagina a sé, Chromium chiude il
// riferimento (SecurityError). Questo script lo prova sulle build vere
// (`dist-web` e `dist-vault`) con le intestazioni del Caddyfile, nelle due
// varianti (opener, follow), più un CONTROLLO con `same-origin` che DEVE
// restare vulnerabile: senza, una sonda rotta passerebbe in silenzio.
//
// Uso: pnpm --filter @stubwise/desktop verify:vault-isolation (dopo
// `build:web` e `build:vault`). Firefox e Safari: vedi il limite nella nota
// di design (§12) e in `docs/invariants/vault.md`.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { APP_ENTRY } from "@stubwise/shared/app-links";
import { VAULT_PAGE_COOP, VAULT_PAGE_CSP, cspHeader } from "../../../scripts/caddy-csp.mjs";

/** L'app e la pagina a sé, come le serve Caddy: `/` e `/vault/` da R1. */
const APP = APP_ENTRY;
const VAULT = `${APP_ENTRY}vault/`;

const desktop = resolve(import.meta.dirname, "..");
const APP_CSP = [cspHeader([]), "require-trusted-types-for 'script'; trusted-types stubwise-vault-worker stubwise-html; worker-src 'self'"];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

function serve(vaultCoop) {
  const json = (res, body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/api/auth/me") return json(res, { user: { id: "u1", email: "a@x" }, instancePermissions: ["instance.full_admin"], sessionTag: "st1" });
    if (path === "/api/vault/status") return json(res, { activated: false, myKey: null, seals: [], passkeys: [] });
    let dist, file, csp, coop;
    if (path.startsWith(VAULT)) {
      [dist, file, csp, coop] = [join(desktop, "dist-vault"), path.slice(VAULT.length), [VAULT_PAGE_CSP], vaultCoop];
      if (!file || !extname(file)) file = "vault.html";
    } else if (path.startsWith(APP)) {
      [dist, file, csp, coop] = [join(desktop, "dist-web"), path.slice(APP.length), APP_CSP, "same-origin"];
      if (!file || !extname(file)) file = "index.html";
    } else {
      res.writeHead(404);
      return res.end();
    }
    try {
      const body = await readFile(join(dist, file));
      res.setHeader("content-security-policy", csp);
      res.setHeader("cross-origin-opener-policy", coop);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
}

/** Una prova: lo «script iniettato» nell'app prende la pagina a sé (`opener` o `follow`) e prova a leggerla. */
async function attempt(browser, port, variant) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}${APP}`);
  await page.waitForLoadState("load");
  const popupP = ctx.waitForEvent("page");
  await page.evaluate(({ target, vault }) => {
    const log = (window.__log = []);
    const w = window.open(target, "_blank");
    window.__w = w;
    const tick = () => {
      try {
        if (w && w.location.pathname.startsWith(vault) && !w.__patched && w.Worker) {
          w.__patched = true;
          const post = w.Worker.prototype.postMessage;
          w.Worker.prototype.postMessage = function (m, t) {
            log.push(`OUT ${JSON.stringify(m)}`);
            return post.call(this, m, t);
          };
          const add = w.EventTarget.prototype.addEventListener;
          w.EventTarget.prototype.addEventListener = function (type, fn, o) {
            if (this instanceof w.Worker && type === "message") {
              const inner = fn;
              fn = function (ev) {
                log.push(`IN ${JSON.stringify(ev.data)}`);
                return inner.call(this, ev);
              };
            }
            return add.call(this, type, fn, o);
          };
          return;
        }
      } catch (e) {
        window.__err = String(e);
      }
      if (!w || !w.__patched) setTimeout(tick, 0);
    };
    tick();
  }, { target: variant === "opener" ? `${VAULT}#/setup` : `${APP}#/home`, vault: VAULT });
  const popup = await popupP;
  await popup.waitForLoadState("load");
  if (variant === "follow") {
    await popup.evaluate((url) => window.location.assign(url), `${VAULT}#/setup`);
    await popup.waitForURL((url) => url.pathname.startsWith(VAULT));
    await popup.waitForLoadState("load");
  }
  // La persona genera il kit nella pagina a sé.
  await popup.getByRole("button", { name: "Generate the recovery kit" }).click();
  const kit = (await popup.locator("pre[data-recovery-kit]").textContent()) ?? "";
  const out = await page.evaluate(() => {
    let dom = null;
    try {
      dom = window.__w.document.querySelector("pre[data-recovery-kit]")?.textContent ?? null;
    } catch {
      dom = null;
    }
    return { handle: !!window.__w && !window.__w.closed, log: window.__log, dom, err: window.__err ?? null };
  });
  await ctx.close();
  const leaked = out.log.some((l) => l.includes(kit)) || out.dom === kit;
  return { readMessages: out.log.length, leaked, kitShown: kit.length > 20, err: out.err };
}

const results = [];
const browser = await chromium.launch();
for (const coop of [VAULT_PAGE_COOP, "same-origin"]) {
  const server = serve(coop);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  for (const variant of ["opener", "follow"]) {
    const r = await attempt(browser, port, variant);
    // Il controllo (`same-origin`) DEVE cadere: è la prova che la sonda vede ciò che cerca.
    const expectLeak = coop === "same-origin";
    const ok = r.kitShown && (expectLeak ? r.leaked && r.readMessages > 0 : !r.leaked && r.readMessages === 0);
    results.push({ ok, coop, variant, ...r });
  }
  server.close();
}
await browser.close();

let failed = false;
for (const r of results) {
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.variant.padEnd(6)} COOP ${r.coop}${r.coop === "same-origin" ? " (controllo)" : ""}: messaggi letti ${r.readMessages}, kit letto ${r.leaked}${r.err ? ` — ${r.err.slice(0, 80)}` : ""}`);
  failed ||= !r.ok;
}
process.exit(failed ? 1 : 0);
