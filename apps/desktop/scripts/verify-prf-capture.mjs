#!/usr/bin/env node
// Prova in Chromium della revisione di sicurezza I-A (cassaforte nel
// browser): uno script arrivato DOPO il boot non ruba l'uscita PRF della
// passkey durante lo sblocco. Una passkey vera con PRF (autenticatore
// virtuale di CDP), il boot vero (`vaultBrowser/boot.ts`: primitive, freeze,
// worker), e per ogni variante l'attacco installato dopo il boot:
// - `hasInstance` e `globalArrayBuffer`: l'`instanceof ArrayBuffer`;
// - `getters`: i getter della credenziale e della risposta, che chiamano il
//   `getClientExtensionResults` nativo;
// - `promise`: `then` sostituito e un getter su `constructor` (l'`await`);
// - `species`: un getter su `constructor` che chiama il `then` NATIVO sulla
//   promessa della piattaforma;
// - `iterator`: l'iteratore degli array sulla lista di transfer.
// Esce con 1 se una variante prende la PRF, se lo sblocco non riesce, o se
// la PRF non arriva al worker. Uso: `pnpm --filter @stubwise/desktop
// verify:prf` (serve Chromium di Playwright).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

const here = import.meta.dirname;
const out = await mkdtemp(join(tmpdir(), "stubwise-prf-probe-"));
await build({
  root: resolve(here, "prf-probe"),
  logLevel: "warn",
  worker: { format: "es" },
  build: { outDir: out, emptyOutDir: true, minify: false },
});

const TYPES = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  try {
    const file = path === "/" ? "index.html" : path.slice(1);
    const body = await readFile(join(out, file));
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "not_found" }));
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;

const VARIANTS = ["none", "hasInstance", "globalArrayBuffer", "getters", "promise", "species", "iterator"];
const browser = await chromium.launch();
let failed = false;
try {
  for (const variant of VARIANTS) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(`http://localhost:${port}/`);
    await page.waitForFunction(() => Boolean(window.__probe));
    const result = await page.evaluate(async (variant) => {
      const probe = window.__probe;
      const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: new Uint8Array(32),
          rp: { id: "localhost", name: "probe" },
          user: { id: new Uint8Array(8), name: "u", displayName: "u" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { userVerification: "required", residentKey: "required" },
          extensions: { prf: {} },
        },
      });
      const credentialId = b64u(cred.rawId);

      // === L'attaccante, DOPO il boot ===
      const stolen = [];
      const installed = [];
      // Ogni buffer che l'attaccante vede, in esadecimale: alla fine si confronta con la PRF vera.
      const seen = [];
      const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
      const grab = (label, value) => {
        try {
          if (value && new Uint8Array(value).length) seen.push([label, hex(value)]);
        } catch {
          // un buffer trasferito (staccato) non si legge
        }
      };
      const nativeExt = PublicKeyCredential.prototype.getClientExtensionResults;
      const steal = (self, label) => {
        try {
          grab(label, nativeExt.call(self).prf.results.first);
        } catch {}
      };
      const attempt = (label, fn) => {
        try {
          fn();
          installed.push(label);
        } catch (e) {
          installed.push(`${label}: bloccato (${e.constructor.name})`);
        }
      };
      // L'attacco risponde il vero, così lo sblocco prosegue e il furto si vede.
      const isAB = (x) => Object.prototype.toString.call(x) === "[object ArrayBuffer]";
      if (variant === "hasInstance") {
        attempt("ArrayBuffer[Symbol.hasInstance]", () =>
          Object.defineProperty(ArrayBuffer, Symbol.hasInstance, {
            value: (x) => {
              grab("instanceof ArrayBuffer", x);
              return isAB(x);
            },
          }),
        );
      } else if (variant === "globalArrayBuffer") {
        const Real = ArrayBuffer;
        attempt("globalThis.ArrayBuffer", () => {
          globalThis.ArrayBuffer = new Proxy(Real, {
            get: (t, k) => (k === Symbol.hasInstance ? (x) => (grab("ArrayBuffer globale", x), isAB(x)) : Reflect.get(t, k)),
          });
        });
      } else if (variant === "getters") {
        for (const [proto, names] of [
          [PublicKeyCredential.prototype, ["response", "rawId", "authenticatorAttachment"]],
          [Credential.prototype, ["id", "type"]],
          [AuthenticatorAssertionResponse.prototype, ["authenticatorData", "signature", "userHandle"]],
          [AuthenticatorResponse.prototype, ["clientDataJSON"]],
        ]) {
          for (const name of names) {
            const d = Object.getOwnPropertyDescriptor(proto, name);
            attempt(`getter ${name}`, () =>
              Object.defineProperty(proto, name, {
                configurable: true,
                get() {
                  if (this instanceof PublicKeyCredential) steal(this, `getter ${name}`);
                  return d.get.call(this);
                },
              }),
            );
          }
        }
        attempt("getClientExtensionResults", () => {
          const hostile = function () {
            steal(this, "getClientExtensionResults");
            return nativeExt.call(this);
          };
          PublicKeyCredential.prototype.getClientExtensionResults = hostile;
          if (PublicKeyCredential.prototype.getClientExtensionResults !== hostile) throw new TypeError("congelato");
        });
      } else if (variant === "promise") {
        const origThen = Promise.prototype.then;
        attempt("Promise.prototype.constructor", () =>
          Object.defineProperty(Promise.prototype, "constructor", { configurable: true, get: () => Object }),
        );
        attempt("Promise.prototype.then", () => {
          const hostile = function (a, b) {
            return origThen.call(
              this,
              (v) => {
                if (Object.prototype.toString.call(v) === "[object PublicKeyCredential]") steal(v, "then");
                return a ? a(v) : v;
              },
              b,
            );
          };
          Promise.prototype.then = hostile;
          if (Promise.prototype.then !== hostile) throw new TypeError("congelato");
        });
      } else if (variant === "species") {
        const origThen = Promise.prototype.then;
        let busy = false;
        attempt("Promise.prototype.constructor (then nativo)", () =>
          Object.defineProperty(Promise.prototype, "constructor", {
            configurable: true,
            get() {
              if (!busy) {
                busy = true;
                origThen.call(this, (v) => {
                  if (Object.prototype.toString.call(v) === "[object PublicKeyCredential]") steal(v, "species");
                });
                busy = false;
              }
              return Promise;
            },
          }),
        );
      } else if (variant === "iterator") {
        const orig = Array.prototype[Symbol.iterator];
        attempt("Array.prototype[Symbol.iterator]", () => {
          Array.prototype[Symbol.iterator] = function () {
            for (let i = 0; i < this.length; i++) {
              if (Object.prototype.toString.call(this[i]) === "[object ArrayBuffer]") grab("iteratore della lista", this[i]);
            }
            return orig.call(this);
          };
        });
      }

      // === Lo sblocco legittimo ===
      let stashed = null;
      // L'oracolo della sonda: la PRF vera, letta qui prima del transfer.
      let realPrf = null;
      const outcome = await probe.ceremony(
        { challenge: b64u(new Uint8Array(32)), rpId: "localhost", userVerification: "required", allowCredentials: [{ id: credentialId }] },
        (prf) => {
          stashed = prf;
          realPrf = new Uint8Array(prf).reduce((a, x) => a + x.toString(16).padStart(2, "0"), "");
          probe.stashPrf(prf);
        },
      );
      for (const [label, value] of seen) if (realPrf && value === realPrf) stolen.push(label);
      // Il worker vero consuma la PRF: senza, direbbe `no_prf`; con, prova la verifica (`not_found` qui).
      const worker = outcome.ok
        ? await probe.request({ t: "unlock", assertion: outcome.assertion, credentialId: outcome.credentialId, personId: "p", sessionTag: "t" })
        : null;
      return {
        ok: outcome.ok,
        code: outcome.ok ? null : outcome.code,
        stolen,
        buffersSeen: seen.length,
        installed,
        detached: stashed ? stashed.byteLength === 0 : null,
        worker,
        assertionHasPrf: outcome.ok ? JSON.stringify(outcome.assertion).includes("results") : null,
      };
    }, variant);
    const good =
      result.ok && result.stolen.length === 0 && result.detached === true && result.worker?.code === "not_found" && !result.assertionHasPrf;
    if (!good) failed = true;
    console.log(`${good ? "ok  " : "FAIL"} ${variant}: ${JSON.stringify(result)}${errors.length ? ` errori: ${errors.join(" | ")}` : ""}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
  await rm(out, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
