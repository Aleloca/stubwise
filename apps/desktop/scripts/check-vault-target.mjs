#!/usr/bin/env node
// Cassaforte nel browser, design §4 (I1): ogni build porta SOLO la sua
// cassaforte. Cerca nei file del bundle i marcatori dell'altra e, se ne
// trova uno, esce con 1.
// - `electron` (`out/`): mai lo sblocco con la passkey della scheda (la PRF,
//   il canale fra le schede di `vaultBrowser/`).
// - `web` (`dist-web/`): mai il ponte del desktop (`window.stubwise.vault` e
//   i moduli che lo usano, `vault/electron.ts` e `vaultDesktop.ts`).
// Uso: `node scripts/check-vault-target.mjs <cartella del bundle> <electron|web>`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Cosa non deve comparire in ciascun target, con il perché. */
export const FORBIDDEN = {
  electron: [
    { re: /prf["']?\s*:\s*\{\s*["']?eval/, why: "l'estensione PRF della passkey (sblocco nella scheda)" },
    { re: /["']stubwise-vault["']/, why: "il canale fra le schede di vaultBrowser/" },
    { re: /stubwise-vault-worker/, why: "il worker della cassaforte nel browser" },
    // m-5 (revisione della fase 2): la fase 2 sta solo nella build web.
    { re: /recovery\/challenge|recovery-key\/preview/, why: "il recupero e la rotazione del kit (fase 2)" },
    { re: /device-pairings\/lookup/, why: "la pagina che sigilla un Mac (fase 2)" },
    { re: /["'](?:recoveryLoad|recoveryConfirm|sealBegin|sealFinish|pairSeal|pairLookup)["']/, why: "le richieste della fase 2 al worker" },
  ],
  web: [
    { re: /stubwise\??\.vault\b/, why: "il ponte del desktop (window.stubwise.vault)" },
    { re: /vault_bridge_missing/, why: "i moduli della cassaforte del desktop (vaultDesktop.ts, vault/electron.ts)" },
  ],
};

/**
 * Cosa DEVE comparire (revisione M-6): i marcatori sentinella del target, così
 * un modulo dimenticato fuori dal bundle (il worker!) fa fallire il controllo.
 */
export const REQUIRED = {
  electron: [{ re: /vault_bridge_missing/, why: "i moduli della cassaforte del desktop" }],
  web: [
    { re: /stubwise-vault-worker/, why: "l'avvio del worker della cassaforte" },
    { re: /["']stubwise-vault["']/, why: "il canale fra le schede" },
  ],
};

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(m?js|cjs|html)$/.test(name)) yield path;
  }
}

/** I marcatori trovati nella cartella per quel target: `[{ file, why }]`. */
export function violations(dir, target) {
  const rules = FORBIDDEN[target];
  if (!rules) throw new Error(`target sconosciuto: ${target}`);
  const out = [];
  let all = "";
  for (const path of files(dir)) {
    const text = readFileSync(path, "utf8");
    all += text;
    for (const { re, why } of rules) if (re.test(text)) out.push({ file: relative(dir, path), why });
  }
  for (const { re, why } of REQUIRED[target]) if (!re.test(all)) out.push({ file: "(bundle)", why: `manca ${why}` });
  // Revisione I-1: la crittografia dello sblocco sta SOLO nel worker, mai nei
  // file della pagina (il sigillo si apre in un reame che la pagina non tocca).
  if (target === "web") {
    for (const path of files(dir)) {
      if (/worker-[\w-]+\.js$/.test(path)) continue;
      const text = readFileSync(path, "utf8");
      if (/stubwise\/vault\/v1\/unlock|\bpkcs8\b/.test(text)) {
        out.push({ file: relative(dir, path), why: "la crittografia dello sblocco fuori dal worker" });
      }
    }
  }
  // Il file del worker deve esistere a sé, fuori dal bundle della pagina.
  if (target === "web" && ![...files(dir)].some((p) => /worker-[\w-]+\.js$/.test(p))) {
    out.push({ file: "(bundle)", why: "manca il file del worker della cassaforte" });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dirArg, target] = process.argv.slice(2);
  if (!dirArg || !target) {
    console.error("uso: check-vault-target.mjs <cartella> <electron|web>");
    process.exit(2);
  }
  const dir = resolve(dirArg);
  const found = violations(dir, target);
  if (found.length > 0) {
    for (const f of found) console.error(`check-vault-target (${target}): ${f.file}: ${f.why}`);
    process.exit(1);
  }
  console.log(`check-vault-target: la build ${target} porta solo la sua cassaforte (${dir})`);
}
