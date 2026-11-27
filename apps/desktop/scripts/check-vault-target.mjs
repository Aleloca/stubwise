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
  ],
  web: [
    { re: /stubwise\??\.vault\b/, why: "il ponte del desktop (window.stubwise.vault)" },
    { re: /vault_bridge_missing/, why: "i moduli della cassaforte del desktop (vaultDesktop.ts, vault/electron.ts)" },
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
  for (const path of files(dir)) {
    const text = readFileSync(path, "utf8");
    for (const { re, why } of rules) if (re.test(text)) out.push({ file: relative(dir, path), why });
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
