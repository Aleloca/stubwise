import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  decrypt,
  projectEnvFiles,
  projectEnvVars,
  projectEnvironments,
  repositories,
  type Db,
} from "@stubwise/db";
import { isSafeRelPath, serializeDotenv } from "@stubwise/shared";
import { and, asc, eq } from "drizzle-orm";

/**
 * File d'ambiente di un repository già caricato e DECIFRATO, pronto per essere
 * materializzato nel worktree. `path` è il percorso relativo configurato sul
 * repository; `vars` sono le coppie chiave/valore in CHIARO. I valori non vanno
 * MAI loggati.
 */
export interface LoadedEnvFile {
  path: string;
  vars: { key: string; value: string }[];
}

/**
 * Carica tutti i file d'ambiente di un repository con le rispettive variabili,
 * decifrando ciascun valore. I file sono ordinati per `path` (deterministico:
 * stabilisce la precedenza last-wins in materializeEnvFiles).
 *
 * **L'invariante della fase 8**: `environment` è tipato sul solo letterale
 * `"test"` — nessun chiamante scritto a mano può passare altro senza un cast
 * esplicito — e la funzione lo riverifica A RUNTIME, lanciando su qualunque
 * altro valore. Non è ridondante: il safeguard anti-leak esistente
 * (`fix.ts`, l'esclusione dei file d'ambiente da ogni `git add`) protegge dal
 * COMMIT di una variabile, non dal resto — il giorno in cui una variabile di
 * `staging`/`production` entra in un worktree, è già entrata in un log, in un
 * prompt dell'agente o nell'ambiente di un sottoprocesso. Le variabili di
 * `staging`/`production` esistono in Stubwise perché una persona le legga e le
 * confronti, mai perché la pipeline le usi.
 *
 * Risolve l'ambiente `test` del PROGETTO del repository (non del repository
 * stesso: gli ambienti sono di progetto) e carica solo i file collegati a
 * quello — un repository con file su `staging`/`production` (creati dalla
 * sezione ambienti, Task 3) non li vede mai qui.
 *
 * Robustezza (best-effort, come loadProviderChain): una variabile il cui valore
 * non si decifra (ENCRYPTION_KEY errata o payload manomesso) viene SCARTATA con
 * un warning — NON blocca le altre né il caricamento del file. Il warning nomina
 * solo file/key per la diagnosi, MAI il valore (cifrato o in chiaro).
 */
export async function loadProjectEnvFiles(
  db: Db,
  repositoryId: string,
  encryptionKey: Buffer,
  environment: "test",
): Promise<LoadedEnvFile[]> {
  if (environment !== "test") {
    throw new Error(
      `loadProjectEnvFiles: ambiente '${String(environment)}' non ammesso in un worktree — solo 'test' può essere materializzato dalla pipeline di fix`,
    );
  }

  const fileRows = await db
    .select({ id: projectEnvFiles.id, path: projectEnvFiles.path })
    .from(projectEnvFiles)
    .innerJoin(projectEnvironments, eq(projectEnvFiles.environmentId, projectEnvironments.id))
    .innerJoin(repositories, eq(projectEnvFiles.repositoryId, repositories.id))
    .where(
      and(
        eq(projectEnvFiles.repositoryId, repositoryId),
        eq(projectEnvironments.kind, "test"),
        // Difensivo: l'ambiente deve appartenere allo STESSO progetto del
        // repository. Vero per costruzione se la scrittura (Task 3) rispetta
        // l'invariante, ma questo loader non se lo assume.
        eq(projectEnvironments.projectId, repositories.projectId),
      ),
    )
    .orderBy(asc(projectEnvFiles.path));

  const result: LoadedEnvFile[] = [];
  for (const file of fileRows) {
    const varRows = await db
      .select({ key: projectEnvVars.key, valueEncrypted: projectEnvVars.valueEncrypted })
      .from(projectEnvVars)
      .where(eq(projectEnvVars.fileId, file.id))
      .orderBy(asc(projectEnvVars.key));

    const vars: { key: string; value: string }[] = [];
    for (const row of varRows) {
      let value: string;
      try {
        value = decrypt(row.valueEncrypted, encryptionKey);
      } catch {
        // Valore non decifrabile: scartiamo questa variabile ma proseguiamo.
        // Mai il valore nel log, solo file+key per la diagnosi.
        console.error(
          `[stubwise-worker] variabile env '${row.key}' del file '${file.path}' scartata: valore non decifrabile (ENCRYPTION_KEY errata o payload non valido)`,
        );
        continue;
      }
      vars.push({ key: row.key, value });
    }
    result.push({ path: file.path, vars });
  }
  return result;
}

/**
 * Materializza i file d'ambiente decifrati dentro `dir` (il worktree effimero) e
 * costruisce la mappa env unificata da iniettare nei comandi (install/test/fix).
 *
 * Sicurezza anti-traversal (doppia difesa): un file viene scritto SOLO se il suo
 * `path` è un path relativo sicuro (isSafeRelPath) E se il path assoluto risolto
 * resta dentro `dir`. Qualsiasi path sospetto viene saltato con un warning e non
 * compare in writtenPaths.
 *
 * Best-effort totale: un errore di filesystem su un singolo file viene loggato e
 * non interrompe gli altri; la funzione non lancia mai. I valori non vengono MAI
 * loggati (solo path + conteggio variabili).
 *
 * Collisioni di chiave nella mappa env: i file sono già ordinati per path dal
 * loader, e la fusione è LAST-WINS (l'ultimo file in ordine vince).
 *
 * @returns writtenPaths = i path RELATIVI effettivamente scritti (per escluderli
 *   dal commit nel wiring del fix); env = la mappa unificata key→value.
 */
export async function materializeEnvFiles(
  dir: string,
  files: LoadedEnvFile[],
): Promise<{ writtenPaths: string[]; env: Record<string, string> }> {
  const rootResolved = resolve(dir);
  const writtenPaths: string[] = [];
  const env: Record<string, string> = {};

  for (const file of files) {
    // Difesa 1: path relativo sicuro (no assoluti, no `..`, no backslash).
    if (!isSafeRelPath(file.path)) {
      console.error(
        `[stubwise-worker] file env '${file.path}' saltato: path non sicuro (sospetto traversal)`,
      );
      continue;
    }
    // Difesa 2: il path assoluto risolto deve restare dentro la dir.
    const abs = resolve(join(dir, file.path));
    if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
      console.error(
        `[stubwise-worker] file env '${file.path}' saltato: risolve fuori dal worktree (sospetto traversal)`,
      );
      continue;
    }

    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, `${serializeDotenv(file.vars)}\n`, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[stubwise-worker] scrittura del file env '${file.path}' fallita (${file.vars.length} variabili): ${message}`,
      );
      continue;
    }

    writtenPaths.push(file.path);
    // Fusione last-wins: i file sono ordinati per path, l'ultimo sovrascrive.
    for (const { key, value } of file.vars) {
      env[key] = value;
    }
  }

  return { writtenPaths, env };
}
