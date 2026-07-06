/**
 * Contratto a marcatori + parser condivisi del motore di documentazione ricorsivo a DAG.
 *
 * Tutti gli output dell'agente machine-parsed (orientamento / explore / synthesize)
 * usano lo STESSO contratto a marcatori del vecchio motore (`generate.ts`):
 * blocchi delimitati da una coppia start/end, ciascun marcatore SOLO sulla propria riga,
 * parsati per-riga (MAI substring/indexOf) e poi VALIDATI. Niente formato libero.
 *
 * Questo modulo raccoglie le PRIMITIVE riusabili — estratte da `generate.ts`, NON
 * duplicate: `generate.ts` re-importa `parseDelimitedBody`, `isMetaSummary` e gli helper
 * di slug da qui — più gli elementi NUOVI del motore ricorsivo:
 *  - i marcatori dei tre output (body + child-list + source-paths);
 *  - un parser di CHILD-LIST robusto (figli che meritano una pagina propria);
 *  - un parser di LISTA di source-path;
 *  - helper di validazione del body (riuso del check anti-meta ancorato all'apertura).
 *
 * ── FORMATO CHILD-LIST (documentato) ───────────────────────────────────────────────
 * I figli sono emessi in un BLOCCO delimitato (markers per output, vedi sotto), una riga
 * per figlio nel formato STABILE delimitato da ` :: ` (spazio-due-punti-due-punti-spazio):
 *
 *     - <title> :: <unitRef-o-paths> :: <why>
 *
 * - Il `- ` iniziale è opzionale (tollerato e rimosso).
 * - I campi sono separati da ` :: `. Il 1° campo (`title`) è OBBLIGATORIO.
 * - Il 2° campo è `unitRef`/`sourcePaths`: per i nodi TECNICI un singolo path/unit-ref;
 *   per i FUNZIONALI uno o più path che implementano la capability, separati da `,`.
 *   `parseChildList` popola SEMPRE `sourcePaths` (lista dei path non vuoti del 2° campo)
 *   e popola `unitRef` col 1° path (comodo per i nodi tecnici a unit-ref singola).
 * - Il 3° campo (`why`) è opzionale.
 * - Righe vuote → ignorate. Righe malformate (senza titolo) → SALTATE e CONTATE
 *   (`malformed`), mai pubblicate: best-effort robusto verso output LLM imperfetto.
 *
 * Si è scelto questo piccolo formato delimitato riga-per-riga (e non JSON libero) perché
 * è molto più robusto del JSON emesso da un LLM: una riga storta non rompe l'intero parse,
 * la si salta soltanto.
 */

import { isMetaSummary, parseDelimitedBody } from "../markers.js";

export {
  isMetaSummary,
  parseDelimitedBody,
  baseSlug,
  makeUniqueSlug,
  META_SUMMARY_RE,
} from "../markers.js";

// ── Marcatori ────────────────────────────────────────────────────────────────────────

/** Marcatore che apre il PIANO di orientamento. */
export const ORIENT_START_MARKER = "===ORIENTATION PLAN===";
/** Marcatore che chiude il piano di orientamento. */
export const ORIENT_END_MARKER = "===END ORIENTATION PLAN===";
/** Apre la child-list delle unità TECNICHE di 1° livello (orientamento). */
export const ORIENT_TECHNICAL_START_MARKER = "===TECHNICAL UNITS===";
/** Chiude la child-list delle unità tecniche di 1° livello. */
export const ORIENT_TECHNICAL_END_MARKER = "===END TECHNICAL UNITS===";
/** Apre la child-list delle capability FUNZIONALI di 1° livello (orientamento). */
export const ORIENT_FUNCTIONAL_START_MARKER = "===FUNCTIONAL CAPABILITIES===";
/** Chiude la child-list delle capability funzionali di 1° livello. */
export const ORIENT_FUNCTIONAL_END_MARKER = "===END FUNCTIONAL CAPABILITIES===";

/** Apre il corpo (markdown) della pagina nel job EXPLORE. */
export const EXPLORE_BODY_START_MARKER = "===EXPLORE BODY===";
/** Chiude il corpo della pagina nel job explore. */
export const EXPLORE_BODY_END_MARKER = "===END EXPLORE BODY===";
/** Apre la child-list dei sotto-nodi che meritano una pagina propria (explore). */
export const EXPLORE_CHILDREN_START_MARKER = "===CHILDREN===";
/** Chiude la child-list dei sotto-nodi (explore). */
export const EXPLORE_CHILDREN_END_MARKER = "===END CHILDREN===";
/** Apre la lista dei source-path coperti dal nodo (explore). */
export const SOURCE_PATHS_START_MARKER = "===SOURCE PATHS===";
/** Chiude la lista dei source-path coperti dal nodo (explore). */
export const SOURCE_PATHS_END_MARKER = "===END SOURCE PATHS===";

/** Apre il corpo (overview/indice) della pagina nel job SYNTHESIZE. */
export const SYNTH_BODY_START_MARKER = "===SYNTHESIS BODY===";
/** Chiude il corpo della pagina nel job synthesize. */
export const SYNTH_BODY_END_MARKER = "===END SYNTHESIS BODY===";

/** Separatore di campo nelle righe di child-list (`title :: ref :: why`). */
export const CHILD_FIELD_SEP = " :: ";

/**
 * Lunghezza minima del body accettata (riuso del valore del deep-pass): sotto soglia
 * il body è trattato come vuoto/degenere e l'output è rifiutato.
 */
export const MIN_BODY_CHARS = 80;

// ── ChildSpec + parser di child-list ─────────────────────────────────────────────────

/**
 * Un figlio che merita una pagina propria, estratto da una child-list.
 * - `title`: etichetta del nodo (obbligatorio);
 * - `unitRef`: path/unit-ref principale (1° dei `sourcePaths`, se presente);
 * - `sourcePaths`: tutti i path del 2° campo (un nodo tecnico ne ha tipicamente uno,
 *   un nodo funzionale i path che implementano la capability);
 * - `why`: motivazione opzionale (auditabile).
 */
export interface ChildSpec {
  title: string;
  unitRef?: string;
  sourcePaths?: string[];
  why?: string;
}

/** Esito del parse di una child-list: i figli validi + il conteggio delle righe scartate. */
export interface ChildListResult {
  children: ChildSpec[];
  /** Numero di righe non vuote ma malformate (senza titolo) saltate. */
  malformed: number;
}

/**
 * Parsa il TESTO INTERNO di un blocco child-list (già estratto tra i suoi marcatori) in
 * `ChildSpec[]`. Vedi il doc-header del modulo per il formato. Tollerante: righe vuote
 * ignorate, righe senza titolo SALTATE e contate (`malformed`). Non lancia mai.
 */
export function parseChildList(body: string): ChildListResult {
  const children: ChildSpec[] = [];
  let malformed = 0;
  for (const raw of body.split("\n")) {
    let line = raw.trim();
    if (line === "") continue;
    // `- ` / `* ` iniziale opzionale (bullet markdown), rimosso. `\s*` (non `\s+`) così
    // anche un bullet "nudo" (`-` da solo) collassa a riga vuota → malformed, non figlio.
    line = line.replace(/^[-*]\s*/, "").trim();
    const parts = line.split(CHILD_FIELD_SEP).map((p) => p.trim());
    const title = parts[0] ?? "";
    if (title === "") {
      malformed += 1;
      continue;
    }
    const refField = parts[1] ?? "";
    const sourcePaths = refField
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    const why = parts.slice(2).join(CHILD_FIELD_SEP).trim();
    const spec: ChildSpec = { title };
    if (sourcePaths.length > 0) {
      spec.unitRef = sourcePaths[0];
      spec.sourcePaths = sourcePaths;
    }
    if (why !== "") spec.why = why;
    children.push(spec);
  }
  return { children, malformed };
}

/**
 * Estrae e parsa una child-list racchiusa tra i suoi marcatori. Ritorna `null` se i
 * marcatori mancano/sono fuori ordine (blocco assente): il chiamante distingue
 * "blocco mancante" (→ output invalido) da "blocco presente ma vuoto" (→ nessun figlio).
 */
export function parseChildBlock(
  output: string,
  start: string,
  end: string,
): ChildListResult | null {
  const inner = extractBlock(output, start, end);
  if (inner === null) return null;
  return parseChildList(inner);
}

/**
 * Parsa una LISTA di source-path delimitata: una riga per path, `- ` iniziale opzionale.
 * Righe vuote ignorate; deduplica preservando l'ordine. Ritorna `[]` per blocco vuoto.
 * I path con un segmento `..` (traversal) sono scartati: nessun path legittimo del repo
 * ne ha, il filtro è solo un safeguard.
 */
export function parsePathList(body: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of body.split("\n")) {
    const path = raw.trim().replace(/^[-*]\s+/, "").trim();
    if (path === "" || seen.has(path)) continue;
    if (path.split("/").includes("..")) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Come `parseDelimitedBody` ma ritorna stringa vuota (non `null`) per un blocco PRESENTE
 * ma vuoto, distinguendolo da un blocco ASSENTE (`null`). Utile per i blocchi opzionali
 * (child-list / source-paths) dove "presente ma vuoto" è legittimo (foglia / nessun path).
 * I marcatori sono riconosciuti SOLO come riga intera (filosofia di `parseDelimitedBody`).
 */
export function extractBlock(
  output: string,
  start: string,
  end: string,
): string | null {
  const lines = output.split("\n");
  const startLine = lines.findIndex((l) => l.trim() === start);
  if (startLine === -1) return null;
  const endLine = lines.findIndex((l, i) => i > startLine && l.trim() === end);
  if (endLine === -1) return null;
  return lines
    .slice(startLine + 1, endLine)
    .join("\n")
    .trim();
}

/**
 * Motivo per cui un BODY è stato rifiutato (per auditabilità via log/stats):
 * - `no-markers`  — marcatori del body mancanti/fuori ordine o corpo vuoto tra essi;
 * - `too-short`   — corpo più corto di `MIN_BODY_CHARS` (vuoto/degenere);
 * - `meta-summary`— l'APERTURA del corpo matcha l'euristica anti-meta-summary.
 */
export type BodyRejection = "no-markers" | "too-short" | "meta-summary";

/**
 * Estrae e VALIDA un body delimitato dai marcatori `start`/`end`. Stessa filosofia del
 * deep-pass: marcatori per-riga, corpo non vuoto, ≥ `MIN_BODY_CHARS`, apertura non-meta.
 * Ritorna `{ body }` se valido oppure `{ reason }` (uno di `BodyRejection`).
 */
export function validateBody(
  output: string,
  start: string,
  end: string,
): { body: string; reason?: never } | { body?: never; reason: BodyRejection } {
  const body = parseDelimitedBody(output, start, end);
  if (body === null) return { reason: "no-markers" };
  if (body.length < MIN_BODY_CHARS) return { reason: "too-short" };
  if (isMetaSummary(body)) return { reason: "meta-summary" };
  return { body };
}
