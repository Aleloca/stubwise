/**
 * Rischio di rilascio di un fix (fase 8, Task 7 — coda di rilascio). Una
 * REGOLA, non un giudizio del modello: stessa disciplina del registro
 * decisioni (CLAUDE.md — un valore generato da un'AI è narrativa travestita
 * da fatto, e qui verrebbe citato come se fosse un fatto). La funzione è pura
 * (nessun I/O, nessuna chiamata a un modello) e spiegabile in una riga: la UI
 * mostra `reason` così com'è, senza doverlo indovinare a posteriori.
 */

export type ReleaseRisk = "low" | "medium" | "high";

export interface ReleaseRiskAssessment {
  level: ReleaseRisk;
  /** Perché, in una riga — la UI la mostra verbatim. */
  reason: string;
}

/** Nome file (ultimo segmento del path), case-insensitive per i lockfile. */
function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

const LOCKFILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "poetry.lock",
  "cargo.lock",
  "gemfile.lock",
]);

/**
 * Trova il PRIMO file ad alto rischio in `changedFiles` e dice perché.
 * Migrazioni: qualunque path sotto una cartella `drizzle`/`migrations`.
 * File d'ambiente o segreti: basename che inizia per `.env`, o un'estensione
 * da chiave/certificato (`.pem`, `.key`, `.p12`), o "secret" nel path.
 * Lockfile: i nomi noti dei package manager più diffusi.
 * CI/deploy: `.github/workflows`, `Dockerfile*`, `docker-compose*`.
 */
function findHighRiskFile(changedFiles: string[]): string | null {
  for (const path of changedFiles) {
    const name = basename(path).toLowerCase();
    const lower = path.toLowerCase();

    if (lower.includes("/drizzle/") || lower.includes("/migrations/")) {
      return `migrazione (${path})`;
    }
    if (
      name.startsWith(".env") ||
      name.endsWith(".pem") ||
      name.endsWith(".key") ||
      name.endsWith(".p12") ||
      lower.includes("secret")
    ) {
      return `file d'ambiente o segreto (${path})`;
    }
    if (LOCKFILE_NAMES.has(name)) {
      return `lockfile (${path})`;
    }
    if (
      lower.includes(".github/workflows/") ||
      name === "dockerfile" ||
      name.startsWith("dockerfile.") ||
      name.startsWith("docker-compose")
    ) {
      return `configurazione di CI/deploy (${path})`;
    }
  }
  return null;
}

/**
 * Calcola il rischio di un FIX (non di un singolo repo): `changedFiles` è
 * l'unione dei path modificati in TUTTI i repo che il fix ha toccato,
 * `repoCount` quanti repo — un fix che coordina più repo porta un rischio suo
 * (le due PR vanno mergiate insieme, o lo stato intermedio è incoerente) a
 * prescindere dal contenuto del diff, a meno che un file specifico non alzi
 * comunque il livello ad alto.
 */
export function computeReleaseRisk(changedFiles: string[], repoCount: number): ReleaseRiskAssessment {
  const highRiskReason = findHighRiskFile(changedFiles);
  if (highRiskReason !== null) return { level: "high", reason: `tocca ${highRiskReason}` };

  if (repoCount > 1) {
    return { level: "medium", reason: `tocca ${repoCount} repository` };
  }

  return { level: "low", reason: "nessun file sensibile, un solo repository" };
}
