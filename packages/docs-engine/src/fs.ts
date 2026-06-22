/**
 * Interfaccia del reader astratto del filesystem per `@stubwise/docs-engine`.
 *
 * La pass strutturale non tocca mai fs/rete direttamente: riceve un `RepoReader`
 * iniettato. In produzione il worker fornisce un'implementazione reale (basata su
 * `git ls-files` + lettura su disco), nei test si usa un fake in-memory. Questo
 * mantiene la logica pura, deterministica e facilmente testabile.
 */
import type { RepoFile } from "./types.js";

export type { RepoFile };

export interface RepoReader {
  /** Tutti i file tracciati (già al netto di `.gitignore`). */
  list(): Promise<RepoFile[]>;
  /** Contenuto testuale di un file, dato il suo path. */
  read(path: string): Promise<string>;
}
