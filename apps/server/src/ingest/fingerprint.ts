import { createHash } from "node:crypto";

export interface FingerprintInput {
  errorType?: string;
  message: string;
  stack?: string;
}

/** Quanti frame dello stack concorrono al fingerprint: i primi N sono la
 * "firma" dell'errore, i frame profondi variano troppo (librerie, polyfill). */
const MAX_FRAMES = 8;

/**
 * Hash di build nel basename dei bundle: un segmento finale `-a1b2c3`
 * (≥6 caratteri alfanumerici) prima dell'estensione, tipico di Vite/Webpack
 * (`app-a1b2c3.js`). Lo strippiamo perché cambia a ogni release pur essendo
 * lo stesso file sorgente. Suffissi corti tipo `-v2` restano: sono semantici.
 */
const BUILD_HASH = /-[a-z0-9]{6,}(?=\.[^.]+$)/i;

/** Posizione `:riga:colonna` (o solo `:riga`) in coda alla location. */
const LINE_COL = /(?::\d+)+$/;

/** Frame V8/Chrome: `at fn (location)` oppure `at location`. */
const V8_FRAME = /^at\s+(?:async\s+)?(?:(.+?)\s+\((.*)\)|(\S+))$/;

/** Frame Firefox/Safari: `fn@location` oppure `@location`. */
const GECKO_FRAME = /^(.*?)@(\S+)$/;

/**
 * Estrae da una riga di stack la coppia (funzione, basename del file)
 * normalizzata, o null se la riga non è un frame riconoscibile (es. la
 * riga del messaggio "TypeError: x is undefined").
 */
function parseFrame(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  let fn: string | undefined;
  let location: string | undefined;

  const v8 = V8_FRAME.exec(trimmed);
  if (v8) {
    fn = v8[1];
    location = v8[2] ?? v8[3];
  } else {
    const gecko = GECKO_FRAME.exec(trimmed);
    // Il match Gecko richiede che la location sembri davvero una posizione
    // (contiene `:`): evita falsi positivi su righe arbitrarie con una @.
    if (gecko?.[2]?.includes(":")) {
      fn = gecko[1] || undefined;
      location = gecko[2];
    }
  }
  if (location === undefined) return null;

  // location → basename stabile: via riga/colonna, query/fragment, path
  // e hash di build. Resta solo il nome "sorgente" del file.
  let file = location.replace(LINE_COL, "");
  file = file.split(/[?#]/, 1)[0] ?? file;
  const basename = file.slice(file.lastIndexOf("/") + 1);
  const stable = basename.replace(BUILD_HASH, "");

  return `${fn ?? "<anonymous>"}@${stable}`;
}

/**
 * Normalizza i valori dinamici di un messaggio d'errore, così "User 12345
 * not found" e "User 67890 not found" collassano nello stesso gruppo.
 * Ordine deliberato: stringhe quotate prima (possono contenere numeri),
 * poi uuid (contengono segmenti hex e numeri), poi id hex lunghi, infine
 * i numeri rimasti.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/"[^"]*"|'[^']*'/g, "<str>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    // Id hex ≥8 caratteri con almeno una cifra: il vincolo sulla cifra evita
    // di mangiare parole reali composte solo da lettere a-f.
    .replace(/\b(?=[a-f]*\d)[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>");
}

/**
 * Fingerprint stabile di un errore: sha256 esadecimale di
 * `errorType + frame normalizzati` (primi {@link MAX_FRAMES}), oppure di
 * `errorType + messaggio normalizzato` se lo stack non ha frame usabili.
 *
 * La normalizzazione dei frame (solo nome funzione + basename senza hash di
 * build né riga/colonna) rende il fingerprint invariante rispetto alle
 * release: lo stesso bug in due build diverse finisce nello stesso
 * ErrorGroup.
 */
export function fingerprint(input: FingerprintInput): string {
  const frames = (input.stack ?? "")
    .split("\n")
    .map(parseFrame)
    .filter((frame): frame is string => frame !== null)
    .slice(0, MAX_FRAMES);

  const signature =
    frames.length > 0 ? frames.join("\n") : normalizeMessage(input.message);

  return createHash("sha256")
    .update(`${input.errorType ?? ""}\n${signature}`)
    .digest("hex");
}
