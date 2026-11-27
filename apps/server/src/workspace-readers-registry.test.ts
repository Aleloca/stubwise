import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⚠️ INVARIANTE DELLE WORKSPACE, VERIFICATA SUL SORGENTE (lotto 2,
 * `docs/plans/2026-11-27-workspace-piano.md`): visibilità, permessi e
 * destinatari si decidono da `project_access` (membri espliciti E persone di
 * workspace, 0238) o dalle funzioni che la leggono, MAI da `project_members`
 * da sola. Una query nuova che unisce `project_members` per decidere chi vede
 * un progetto dimentica le persone di workspace in silenzio.
 *
 * Il test: nessun file di `apps/server/src`, `apps/worker/src` e
 * `packages/*\/src` (test esclusi) nomina `projectMembers` o
 * `project_members` fuori da un elenco CHIUSO. L'elenco è dei siti dove
 * «membro» vuol dire «membro ESPLICITO»: le scritture, la gestione dei membri,
 * le viste che mostrano le appartenenze. Chi aggiunge un file all'elenco
 * scrive perché lì serve il membro esplicito; altrimenti la riga da cambiare
 * non è il test, è la query.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const ALLOWED: Readonly<Record<string, readonly [number, string]>> = {
  "packages/db/src/schema.ts": [8, "la tabella stessa"],
  "packages/db/src/member-permissions.ts": [2, "la regola (`memberPermissionsSql`, il pezzo sui membri espliciti) accanto a quella di `project_access`"],
  "apps/server/src/services/roles.ts": [28, "scrittura e gestione dei membri (put/remove, invito, eliminazione, elenco dei membri)"],
  "apps/server/src/services/admin-roles.ts": [5, "le viste dei membri e dei ruoli assegnati (sezione Members, chi ha un ruolo)"],
  "apps/server/src/services/admin-people.ts": [12, "le appartenenze esplicite di una persona nella pagina People"],
  "apps/server/src/services/access-query.ts": [5, "il ruolo ESPLICITO accanto alle fonti di «Chi può farlo?» (chi accede viene da `project_access`)"],
  "apps/server/src/services/mail-proposals-decide.ts": [11, "aggiunge (e toglie) i Contributor di una conferma: scrittura"],
  "apps/server/src/services/project-archive.ts": [9, "la vista di un archiviato e la copia dei membri all'eliminazione"],
  "apps/server/src/routes/projects.ts": [2, "il creatore entra come lead: scrittura"],
  "apps/server/src/claude-actions/catalog-area9.ts": [5, "«Annulla» di Claude su un ingresso: il membro esplicito"],
  "apps/server/src/claude-actions/labels.ts": [5, "il nome del ruolo esplicito nelle etichette delle azioni"],
  "apps/server/src/claude-actions/undo.ts": [4, "i lock sulle righe dei membri esplicite"],
};

const ROOTS = ["apps/server/src", "apps/worker/src", ...readdirSync(join(repoRoot, "packages")).map((p) => `packages/${p}/src`)];
const NAMES = /\bprojectMembers\b|\bproject_members\b/;
const occurrences = (file: string) => readFileSync(join(repoRoot, file), "utf8").match(/\bprojectMembers\b|\bproject_members\b/g)?.length ?? 0;

function sources(dir: string): string[] {
  const abs = join(repoRoot, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const full = join(abs, name);
    if (statSync(full).isDirectory()) return name === "test" || name === "node_modules" || name === "dist" ? [] : sources(relative(repoRoot, full));
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [relative(repoRoot, full)] : [];
  });
}

describe("le workspace: chi decide l'accesso legge project_access", () => {
  const all = ROOTS.flatMap(sources);

  it("le radici esistono (il test non passa a vuoto)", () => {
    expect(all.length).toBeGreaterThan(500);
    expect(all).toContain("packages/notifications/src/project-access.ts");
  });

  it("nessun file fuori dall'elenco nomina project_members", () => {
    const offenders = all.filter((file) => !(file in ALLOWED) && NAMES.test(readFileSync(join(repoRoot, file), "utf8")));
    expect(offenders, "Usa `project_access` (o projectAccessSql / projectAccessPermissionsSql): la riga da cambiare è la query, non questo test").toEqual([]);
  });

  /**
   * Revisione del lotto 2: l'elenco è per FILE, quindi una query di visibilità
   * nuova dentro un file elencato passerebbe. Il numero delle occorrenze lo
   * ferma: chi lo cambia guarda la riga nuova e decide se è gestione (si
   * aggiorna il numero) o visibilità (si usa `project_access`).
   */
  it("ogni voce dell'elenco nomina project_members esattamente quante volte dice", () => {
    const drift = Object.entries(ALLOWED)
      .map(([file, [expected]]) => ({ file, expected, actual: occurrences(file) }))
      .filter((row) => row.actual !== row.expected);
    expect(drift, "Una riga nuova con project_members: è gestione (aggiorna il numero) o visibilità (usa project_access)?").toEqual([]);
  });
});
