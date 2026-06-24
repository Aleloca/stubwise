/**
 * REFRESH PAGE — agente di rigenerazione MIRATA di una pagina (auto-aggiornamento Docs,
 * Fase 2).
 *
 * Dopo aver mappato i file cambiati alle pagine impattate (`mapAffectedPages`), per ogni
 * pagina toccata un agente — read-only nel worktree del repo al commit AGGIORNATO (cwd
 * già impostato dal chiamante, `permissionMode: "plan"`) — riceve il corpo ATTUALE della
 * pagina + il suo `sourcePath` + il contesto del diff (file cambiati che la riguardano,
 * subject dei commit) e produce il CORPO MARKDOWN aggiornato della pagina, conservandone
 * struttura/stile e correggendo SOLO ciò che è cambiato (niente stravolgimenti, niente
 * cambi di titolo). Se la pagina è ancora corretta, emette un no-op.
 *
 * Come gli altri agenti del motore, l'output è MACHINE-PARSED con un CONTRATTO A
 * MARCATORI (mai formato libero), parsato per-riga. Logica PURA: niente IO, il chiamante
 * (worker) fornisce gli input e fa girare l'agente nel worktree.
 *
 * Output (contratto), uno dei due:
 *
 *     ===NO CHANGE===
 *
 * oppure
 *
 *     ===UPDATED PAGE===
 *     <corpo markdown completo aggiornato della pagina>
 *     ===END UPDATED PAGE===
 *
 * Default PRUDENTE del parser: marcatori mancanti / output vuoto / corpo vuoto →
 * `unchanged` (la pagina NON viene toccata, così un output ambiguo non distrugge la doc).
 */

import { extractBlock } from "./recursive/contract.js";

/** Marcatore di no-op: la pagina è ancora corretta, nessuna modifica necessaria. */
export const REFRESH_NO_CHANGE_MARKER = "===NO CHANGE===";
/** Apre il corpo markdown aggiornato della pagina. */
export const REFRESH_UPDATED_START_MARKER = "===UPDATED PAGE===";
/** Chiude il corpo markdown aggiornato della pagina. */
export const REFRESH_UPDATED_END_MARKER = "===END UPDATED PAGE===";

/** Input testuale dell'agente di refresh di una singola pagina. */
export interface RefreshPageInput {
  /** Titolo della pagina (NON va cambiato dall'agente). */
  title: string;
  /** Path del sorgente documentato dalla pagina; null per overview/manuali. */
  sourcePath: string | null;
  /** Corpo markdown ATTUALE della pagina (da aggiornare in-place). */
  currentBody: string;
  /** File cambiati nel diff che riguardano QUESTA pagina (già filtrati dal chiamante). */
  changedFiles: string[];
  /** Subject dei commit nel range (dal più recente), per orientare l'agente. */
  commitSubjects: string[];
}

/** Esito del parse del refresh: pagina invariata oppure corpo aggiornato. */
export type RefreshedPage =
  | { kind: "unchanged" }
  | { kind: "updated"; body: string };

/** Tetto al numero di righe di contesto per sezione: niente prompt sterminato. */
const MAX_FILES = 200;
const MAX_COMMITS = 200;

/**
 * Costruisce il prompt dell'agente di refresh-pagina. L'agente gira READ-ONLY nel
 * worktree del repo al commit aggiornato (cwd già impostato dal chiamante): DEVE leggere
 * il codice attuale sotto `sourcePath` (e i `changedFiles` rilevanti) e riscrivere il
 * CORPO MARKDOWN della pagina, conservandone struttura/stile e aggiornando SOLO ciò che è
 * cambiato. L'output usa SOLO il contratto a marcatori (no-op o corpo aggiornato).
 */
export function buildRefreshPagePrompt(input: RefreshPageInput): string {
  const files =
    input.changedFiles.length > 0
      ? input.changedFiles.slice(0, MAX_FILES).map((f) => `- ${f}`).join("\n")
      : "(no changed files listed)";
  const commits =
    input.commitSubjects.length > 0
      ? input.commitSubjects.slice(0, MAX_COMMITS).map((s) => `- ${s}`).join("\n")
      : "(no commit subjects)";

  return [
    "You are UPDATING ONE existing page of documentation for a software repository after a",
    "code change. You are running READ-ONLY in the repository working directory, already",
    "checked out at the UPDATED commit: READ the relevant code to be accurate — ground",
    "everything in what the code NOW actually does, do not invent.",
    "",
    `Page title: ${input.title}`,
    `Source path documented by this page: ${input.sourcePath ?? "(none)"}`,
    "",
    "CHANGED FILES relevant to this page (read the ones that matter):",
    files,
    "",
    "COMMIT SUBJECTS (most recent first), for orientation:",
    commits,
    "",
    "CURRENT PAGE BODY (markdown) — delimited below by the CURRENT BODY markers; this is",
    "what you are updating, it is NOT part of your output:",
    "===CURRENT BODY===",
    input.currentBody.trim() || "(empty)",
    "===END CURRENT BODY===",
    "",
    "YOUR TASK:",
    "- READ the current code under the source path above (and the relevant changed files)",
    "  to see what the code does NOW.",
    "- Then UPDATE the page body so it matches the current behaviour, KEEPING the existing",
    "  structure, style, headings and register. Change ONLY what the code change actually",
    "  affected: do NOT rewrite the page wholesale, do NOT change the page title, do NOT",
    "  add or remove sections that the change does not touch.",
    "- If the existing page is STILL correct (the change did not affect anything this page",
    "  documents), make NO change and emit the no-op marker.",
    "",
    "OUTPUT CONTRACT — obey this EXACTLY. Emit ONE of the two forms below and NOTHING that",
    "matters outside the markers (any other text is ignored). Each marker stands ALONE on",
    "its own line.",
    "",
    "1) If the page is still correct and needs no substantive change, emit ONLY this single",
    "   marker line, by itself:",
    REFRESH_NO_CHANGE_MARKER,
    "",
    "2) Otherwise, emit the FULL updated markdown body BETWEEN these two markers:",
    REFRESH_UPDATED_START_MARKER,
    "<the full updated markdown body of the page>",
    REFRESH_UPDATED_END_MARKER,
    "",
    "ANTI-META RULES: write ONLY the documentation body. Do NOT save anything to any file,",
    'do NOT add meta-commentary, preamble or closing remarks such as "here is the updated',
    'page", "I now have…" or "let me know if…". Do not wrap the body in a code fence and do',
    "NOT begin the body with a top-level `#`/`##` page title (the title is rendered",
    "separately by the UI and would be duplicated).",
  ].join("\n");
}

/**
 * Parsa l'output dell'agente di refresh. Riusa `extractBlock` (estrazione per-riga,
 * marcatori riconosciuti solo come riga intera) degli altri parser.
 *
 * - Blocco `UPDATED PAGE` presente con corpo NON vuoto (dopo trim) → `{ updated, body }`.
 * - Altrimenti, se è presente il marcatore `NO CHANGE` → `{ unchanged }`.
 * - Default PRUDENTE: marcatori mancanti / output vuoto / corpo vuoto → `{ unchanged }`
 *   (un output ambiguo NON deve distruggere la pagina: non si tocca nulla).
 */
export function parseRefreshedPage(output: string): RefreshedPage {
  const body = extractBlock(
    output,
    REFRESH_UPDATED_START_MARKER,
    REFRESH_UPDATED_END_MARKER,
  );
  if (body !== null && body.trim() !== "") {
    return { kind: "updated", body: body.trim() };
  }
  // Niente blocco UPDATED PAGE valido: se l'agente ha emesso il no-op (o l'output è
  // ambiguo/vuoto/corpo vuoto), prudenzialmente non si tocca la pagina.
  return { kind: "unchanged" };
}
