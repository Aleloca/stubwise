/**
 * RELEASE NOTES — generatore delle note di rilascio (auto-aggiornamento Docs, Fase 1).
 *
 * Ad ogni push (con debounce) un agente legge il DIFF del range e produce una "entry
 * release": un breve changelog in markdown, un titolo, un flag di SIGNIFICATIVITÀ
 * (modifica rilevante per l'utente vs cambiamento minore) e l'elenco degli SLUG delle
 * pagine di documentazione esistenti impattate (solo per i cross-link della entry, NON
 * per rigenerare i docs in questa fase).
 *
 * Come gli altri agenti del motore, l'output è MACHINE-PARSED con un CONTRATTO A
 * MARCATORI (mai formato libero), parsato per-riga e poi validato. Logica pura: il
 * chiamante (worker) fornisce i file cambiati, i subject dei commit e l'elenco delle
 * pagine esistenti; questo modulo costruisce il prompt e parsa l'output.
 *
 * Output (contratto):
 *
 *     ===RELEASE NOTES===
 *     SIGNIFICANT: true|false
 *     TITLE: <titolo breve, una riga>
 *     ===AFFECTED SLUGS===
 *     - <slug-di-una-pagina-esistente>
 *     …
 *     ===END AFFECTED SLUGS===
 *     ===RELEASE BODY===
 *     <markdown delle note di rilascio>
 *     ===END RELEASE BODY===
 *     ===END RELEASE NOTES===
 */

import { extractBlock, parsePathList } from "./recursive/contract.js";

/** Apre il blocco complessivo delle note di rilascio. */
export const RELEASE_START_MARKER = "===RELEASE NOTES===";
/** Chiude il blocco complessivo delle note di rilascio. */
export const RELEASE_END_MARKER = "===END RELEASE NOTES===";
/** Apre la lista degli slug delle pagine esistenti impattate. */
export const RELEASE_SLUGS_START_MARKER = "===AFFECTED SLUGS===";
/** Chiude la lista degli slug impattati. */
export const RELEASE_SLUGS_END_MARKER = "===END AFFECTED SLUGS===";
/** Apre il corpo markdown delle note di rilascio. */
export const RELEASE_BODY_START_MARKER = "===RELEASE BODY===";
/** Chiude il corpo markdown delle note di rilascio. */
export const RELEASE_BODY_END_MARKER = "===END RELEASE BODY===";

/** Prefisso (riga) del flag di significatività dentro il blocco RELEASE NOTES. */
const SIGNIFICANT_PREFIX = "SIGNIFICANT:";
/** Prefisso (riga) del titolo dentro il blocco RELEASE NOTES. */
const TITLE_PREFIX = "TITLE:";

/** Una pagina esistente passata all'agente come contesto (per citarne gli slug). */
export interface ExistingPage {
  slug: string;
  title: string;
  /** Path del sorgente documentato (modulo/file); null per overview/manuali. */
  sourcePath: string | null;
}

/** Input testuale dell'agente di release: niente worktree, solo il contesto del diff. */
export interface ReleaseInput {
  /** File cambiati nel range (già filtrati dal rumore dal chiamante). */
  changedFiles: string[];
  /** Subject dei commit nel range (dal più recente). */
  commitSubjects: string[];
  /** Pagine di documentazione esistenti, per citare quelle impattate via slug. */
  existingPages: ExistingPage[];
}

/** Le note di rilascio parsate dall'output dell'agente. */
export interface ReleaseNotes {
  /** true = modifica rilevante per l'utente; false = cambiamento minore. */
  significant: boolean;
  /** Titolo breve della entry. */
  title: string;
  /** Corpo markdown delle note di rilascio. */
  body: string;
  /** Slug delle pagine esistenti impattate (per i cross-link "related"). */
  affectedSlugs: string[];
}

/** Tetto al numero di righe di contesto per sezione: niente prompt sterminato. */
const MAX_FILES = 200;
const MAX_COMMITS = 200;
const MAX_PAGES = 300;

/**
 * Costruisce il prompt dell'agente di release. È un'analisi PURAMENTE TESTUALE: il
 * chiamante passa i file cambiati, i subject dei commit e le pagine esistenti, senza
 * worktree (in Fase 1 non si rigenera codice, bastano i fatti del diff). L'agente
 * scrive il changelog con SOLO il contratto a marcatori, niente prosa fuori.
 */
export function buildReleasePrompt(input: ReleaseInput): string {
  const files =
    input.changedFiles.length > 0
      ? input.changedFiles.slice(0, MAX_FILES).map((f) => `- ${f}`).join("\n")
      : "(nessun file)";
  const commits =
    input.commitSubjects.length > 0
      ? input.commitSubjects.slice(0, MAX_COMMITS).map((s) => `- ${s}`).join("\n")
      : "(nessun commit)";
  const pages =
    input.existingPages.length > 0
      ? input.existingPages
          .slice(0, MAX_PAGES)
          .map((p) => `- ${p.slug} :: ${p.title}${p.sourcePath ? ` :: ${p.sourcePath}` : ""}`)
          .join("\n")
      : "(nessuna pagina di documentazione esistente)";

  return [
    "You are writing RELEASE NOTES (a changelog entry) for a software project, based on",
    "the changes pushed since the documentation was last in sync. Work ONLY from the",
    "facts below: the list of changed files, the commit subjects, and the existing",
    "documentation pages. Do NOT invent changes that are not implied by these facts.",
    "",
    "CHANGED FILES (noise such as lockfiles and process/doc folders already removed):",
    files,
    "",
    "COMMIT SUBJECTS (most recent first):",
    commits,
    "",
    "EXISTING DOCUMENTATION PAGES (slug :: title :: source path):",
    pages,
    "",
    "DO THREE THINGS:",
    "",
    "1. DECIDE SIGNIFICANCE. Mark the release SIGNIFICANT (true) when the changes are",
    "   meaningful to a USER of the product (new capability, behaviour change, fix of a",
    "   user-visible bug, breaking change). Mark it NOT significant (false) when the",
    "   changes are internal-only and irrelevant to users (refactors with no behaviour",
    "   change, test-only changes, formatting, dependency bumps with no user impact).",
    "",
    "2. WRITE THE NOTES as concise markdown: a short summary, then bullet points grouped",
    "   sensibly (e.g. Added / Changed / Fixed). Describe WHAT changed from the user's",
    "   point of view, not a raw file list. Keep it tight and factual.",
    "",
    "3. LIST AFFECTED PAGES. From the EXISTING documentation pages above, list the SLUGS",
    "   (exactly as given) of the pages whose subject matter is touched by these changes,",
    "   so the entry can cross-link to them. List only slugs that appear above; if none",
    "   apply, leave the list empty.",
    "",
    "OUTPUT CONTRACT — obey this EXACTLY. Put EVERYTHING between the RELEASE NOTES markers.",
    "Write no free prose outside the markers. Each marker stands ALONE on its own line.",
    "SIGNIFICANT must be exactly 'true' or 'false'. TITLE is a single short line.",
    "",
    RELEASE_START_MARKER,
    `${SIGNIFICANT_PREFIX} true`,
    `${TITLE_PREFIX} <short one-line title>`,
    RELEASE_SLUGS_START_MARKER,
    "- <slug of an existing page impacted by these changes>",
    RELEASE_SLUGS_END_MARKER,
    RELEASE_BODY_START_MARKER,
    "<the release notes as markdown>",
    RELEASE_BODY_END_MARKER,
    RELEASE_END_MARKER,
    "",
    "Do NOT save anything to any file and write NOTHING outside the RELEASE NOTES markers.",
  ].join("\n");
}

/**
 * Parsa e VALIDA l'output dell'agente di release. Richiede il blocco RELEASE NOTES con
 * un corpo markdown NON VUOTO; SIGNIFICANT e TITLE sono cercati come righe-prefisso
 * dentro il blocco (SIGNIFICANT default false se assente/illeggibile, prudente). La
 * lista AFFECTED SLUGS è opzionale (assente/vuota → nessuno slug). Ritorna `null` se il
 * blocco o il corpo mancano (output non parsabile, niente formato libero).
 */
export function parseReleaseNotes(output: string): ReleaseNotes | null {
  const block = extractBlock(output, RELEASE_START_MARKER, RELEASE_END_MARKER);
  if (block === null) return null;

  const body = extractBlock(output, RELEASE_BODY_START_MARKER, RELEASE_BODY_END_MARKER);
  if (body === null || body.trim() === "") return null;

  const slugsInner = extractBlock(
    output,
    RELEASE_SLUGS_START_MARKER,
    RELEASE_SLUGS_END_MARKER,
  );
  const affectedSlugs = slugsInner === null ? [] : parsePathList(slugsInner);

  // SIGNIFICANT e TITLE: righe-prefisso DENTRO il blocco RELEASE NOTES (per-riga, mai
  // substring). Il significato di default è "minore" (false) se la riga manca o è
  // illeggibile — più prudente che gonfiare il changelog.
  let significant = false;
  let title = "";
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(SIGNIFICANT_PREFIX)) {
      significant = line.slice(SIGNIFICANT_PREFIX.length).trim().toLowerCase() === "true";
    } else if (line.startsWith(TITLE_PREFIX)) {
      title = line.slice(TITLE_PREFIX.length).trim();
    }
  }

  // Titolo mancante: ripieghiamo su un titolo neutro così la entry resta valida.
  if (title === "") title = "Changes";

  return { significant, title, body: body.trim(), affectedSlugs };
}
