#!/usr/bin/env node
// Nessun dato del seed del prototipo in una build «app» (integrazione area 2,
// fetta 1, anti-obiettivo «dati finti davanti a un utente vero»). Cerca nei
// file del bundle i nomi delle persone del seed: se ne trova uno, esce con 1.
// Uso: `node scripts/check-no-seed.mjs <cartella del bundle>`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** I nomi delle persone del seme, scritti a mano. */
export const SEED_MARKERS = ["Giulia Ferri", "Laura Costa", "p-giulia"];

/**
 * Una stringa unica che vive SOLO nel seme (`data/seed/people.ts`, sulla
 * proprietà `seedCanary` di `PEOPLE`): se il seme entra nel bundle, entra lei.
 */
export const SEED_CANARY = "stubwise-seed-canary-3f9c27d1";

const RENDERER = resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer");
const SEED_DIR = join(RENDERER, "data/seed");

/** Il testo del renderer FUORI dal seme (pagine, locali, livello dati): ciò che può stare in un bundle. */
function productText() {
  let text = "";
  for (const path of files(RENDERER)) {
    if (path.startsWith(SEED_DIR) || /\.test\.[tj]sx?$/.test(path)) continue;
    if (!/\.(tsx?|json)$/.test(path)) continue;
    text += readFileSync(path, "utf8");
  }
  return text;
}
/** I primi titoli e nomi lunghi di ogni file del seme: un dato vero di ciascuno. */
const PER_FILE = 3;
const LITERAL = /\b(?:title|name|subject|question)\s*:\s*"([^"\\]{14,80})"/g;

/**
 * Tutti i marcatori: i nomi scritti a mano, il canary, e alcuni titoli per
 * file di `data/seed/` (letti dai sorgenti, così un modulo del seme che
 * entrasse nel bundle senza persone verrebbe comunque visto), tolti quelli
 * che compaiono anche fuori dal seme.
 */
export function seedMarkers() {
  const out = new Set([...SEED_MARKERS, SEED_CANARY]);
  // Un titolo del seme che è anche un testo del prodotto («Administration»)
  // non dice niente: vale solo ciò che esiste SOLO nel seme.
  const product = productText();
  for (const path of files(SEED_DIR)) {
    if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
    let taken = 0;
    for (const [, value] of readFileSync(path, "utf8").matchAll(LITERAL)) {
      if (taken >= PER_FILE) break;
      if (product.includes(value)) continue;
      out.add(value);
      taken += 1;
    }
  }
  return [...out];
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

/** I file di `dir` che contengono un marcatore del seed, con il marcatore. */
export function findSeed(dir, markers = seedMarkers()) {
  const hits = [];
  for (const path of files(dir)) {
    const text = readFileSync(path, "latin1");
    for (const marker of markers) {
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
