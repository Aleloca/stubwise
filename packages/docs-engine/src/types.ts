/**
 * Tipi del repo map prodotto dalla pass strutturale di `@stubwise/docs-engine`.
 *
 * Il repo map è il risultato deterministico dell'analisi statica di un
 * repository: elenca i linguaggi, segmenta il codice in moduli (con manifest,
 * superficie pubblica e grafo delle dipendenze) e tiene traccia di ciò che è
 * stato escluso o tagliato per budget (`skipped`). È una struttura pura,
 * serializzabile, indipendente da fs/rete.
 */

/** Un file tracciato del repository (path relativo alla root + dimensione in byte). */
export interface RepoFile {
  path: string;
  size: number;
}

/** Un modulo identificato nel repository (confine = manifest o directory a profondità fissa). */
export interface ModuleNode {
  /** Directory del modulo, relativa alla root del repo (`""` per la root). */
  path: string;
  /** Linguaggio dominante del modulo (estensione, es. `.ts`) o `null` se indeterminato. */
  language: string | null;
  /** Path dei file appartenenti al modulo. */
  files: string[];
  /** Path del file manifest del modulo (`package.json`, …) o `null` se assente. */
  manifest: string | null;
  /** Simboli pubblici rilevati (export/route/CLI). Euristiche regex TS/JS in v1. */
  publicSurface: string[];
  /** Path di altri moduli da cui questo dipende (grafo delle dipendenze). */
  dependsOn: string[];
  /** Priorità del modulo (size + centralità nel grafo + superficie pubblica). */
  score: number;
}

/** Risultato della pass strutturale: linguaggi, moduli e cose escluse/tagliate. */
export interface RepoMap {
  /** Conteggio file per estensione (es. `{ ".ts": 12 }`). */
  languages: Record<string, number>;
  /** Moduli identificati, ordinati per `score` decrescente ed entro il budget. */
  modules: ModuleNode[];
  /** Path esclusi/tagliati con motivazione (esclusioni dir/binari, budget moduli). */
  skipped: { path: string; reason: string }[];
}
