#!/usr/bin/env node
// Nessun dato del seed del prototipo in una build «app» (integrazione area 2,
// fetta 1, anti-obiettivo «dati finti davanti a un utente vero»). Cerca nei
// file del bundle i nomi delle persone del seed: se ne trova uno, esce con 1.
// Uso: `node scripts/check-no-seed.mjs <cartella del bundle>`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SEED_MARKERS = ["Giulia Ferri", "Laura Costa", "p-giulia"];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

/** I file di `dir` che contengono un marcatore del seed, con il marcatore. */
export function findSeed(dir) {
  const hits = [];
  for (const path of files(dir)) {
    const text = readFileSync(path, "latin1");
    for (const marker of SEED_MARKERS) {
      if (text.includes(marker)) hits.push({ file: relative(dir, path), marker });
    }
  }
  return hits;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("uso: check-no-seed.mjs <cartella>");
    process.exit(2);
  }
  const hits = findSeed(dir);
  if (hits.length > 0) {
    for (const h of hits) console.error(`seed nel bundle: ${h.file} contiene «${h.marker}»`);
    process.exit(1);
  }
  console.log(`check-no-seed: nessun dato del seed in ${dir}`);
}
