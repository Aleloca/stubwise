/**
 * Tipi del reader del repository per `@stubwise/docs-engine`.
 *
 * Il motore non tocca mai fs/rete direttamente: riceve un `RepoReader` iniettato
 * (vedi `fs.ts`) che enumera e legge i file tracciati. `RepoFile` è l'unità che il
 * reader produce — pura e serializzabile, indipendente da fs/rete.
 */

/** Un file tracciato del repository (path relativo alla root + dimensione in byte). */
export interface RepoFile {
  path: string;
  size: number;
}
