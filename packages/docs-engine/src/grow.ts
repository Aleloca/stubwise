/**
 * GROW — mattoni PURI per la Fase 3 dell'auto-aggiornamento Docs: creazione
 * incrementale di pagine per le AREE NUOVE del repo (file che nessuna pagina
 * copre via `sourcePath`).
 *
 * Due responsabilità, entrambe deterministiche e senza side-effect:
 *  1. `aggregateNewAreas` — accorpa la lista dei file nuovi (path singoli, come
 *     tornati da `mapAffectedPages`) in AREE coese, un'area per pagina candidata.
 *  2. Contratto MINI-ORIENT — `buildGrowOrientPrompt` costruisce il prompt di un
 *     singolo run agente (read-only) che decide QUALI pagine creare per le aree
 *     nuove; `parseGrowOrientOutput` ne parsa l'output a marcatori (best-effort,
 *     mai throw), nello stile degli altri agenti del motore (contratto a
 *     marcatori + validazione, mai formato libero).
 *
 * ── REGOLA DI AGGREGAZIONE (documentata) ──────────────────────────────────────
 * Ogni file è associato alla sua cartella. La cartella viene TRONCATA ad al più
 * `maxDepth` segmenti (default 2): una cartella più profonda di `maxDepth` risale
 * fino al suo antenato a profondità `maxDepth`; una cartella a profondità ≤
 * `maxDepth` resta invariata. Tutti i file la cui cartella tronca allo stesso path
 * finiscono nella STESSA area. Un file nella RADICE del repo (senza cartella)
 * diventa un'area col path del file stesso.
 * Così 30 file sparsi in sottocartelle diverse di `admin-app/src/**` (profondità 3)
 * troncano tutti a `admin-app/src` → 1 sola area; `app-a/src/**` e `app-b/src/**`
 * troncano a `app-a/src` e `app-b/src` (differiscono al 1° segmento < maxDepth) → 2
 * aree distinte; `src/lib/util.ts` (cartella `src/lib`, profondità 2 = maxDepth)
 * resta `src/lib`.
 * Le aree annidate (una copre l'altra) vengono FUSE nell'antenato, così le aree sono
 * sempre DISGIUNTE. `minGroup` (default 2): aree SORELLE (stesso genitore di cartella)
 * ciascuna con MENO di `minGroup` file vengono fuse nel genitore comune, per evitare una
 * proliferazione di micro-pagine da un solo file (es. `a/x/one.ts` + `a/y/one.ts` → area
 * `a`); un frammento isolato resta autonomo.
 * Output ordinato lessicograficamente per `path`, file di ogni area ordinati e
 * dedupati.
 */

// ── Aggregazione file → aree ─────────────────────────────────────────────────

/** Un'area coesa del repo: la cartella (o file) che la identifica + i suoi file. */
export interface NewArea {
  /** Path che identifica l'area (cartella accorpata, o path del file se in radice). */
  path: string;
  /** File coperti dall'area (ordinati lessicograficamente, dedupati). */
  files: string[];
}

/** Opzioni dell'aggregazione (soglie di accorpamento). */
export interface AggregateOptions {
  /** Sotto questa dimensione un gruppo profondo risale al genitore (default 2). */
  minGroup?: number;
  /** Un gruppo risale finché la profondità della cartella è > di questo (default 2). */
  maxDepth?: number;
}

/** Normalizza un path: slash iniziali/finali rimossi, slash ripetuti collassati. */
function normalizePath(p: string): string {
  return p
    .split("/")
    .filter((seg) => seg !== "")
    .join("/");
}

/** Cartella di un path file (segmenti tranne l'ultimo). Stringa vuota se in radice. */
function dirOf(path: string): string {
  const segs = path.split("/");
  return segs.slice(0, -1).join("/");
}

/** Tronca una cartella ad al più `maxDepth` segmenti (profondità = numero di segmenti). */
function truncateDir(dir: string, maxDepth: number): string {
  if (dir === "") return "";
  const segs = dir.split("/");
  return segs.length <= maxDepth ? dir : segs.slice(0, maxDepth).join("/");
}

/** true se `parent` è un prefisso di cartella di `child` (o uguale). */
function covers(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(`${parent}/`);
}

/**
 * Accorpa i file nuovi in aree coese secondo la regola documentata nel doc-header
 * (troncamento della cartella a `maxDepth` + fusione delle aree annidate). Pura e
 * deterministica: stesso input → stesso output (ordinamento lessicografico).
 */
export function aggregateNewAreas(files: string[], opts?: AggregateOptions): NewArea[] {
  const minGroup = opts?.minGroup ?? 2;
  const maxDepth = opts?.maxDepth ?? 2;

  // 1. Normalizza + dedup + ordina i file.
  const normalized = Array.from(
    new Set(files.map(normalizePath).filter((p) => p !== "")),
  ).sort();
  if (normalized.length === 0) return [];

  // 2. Ogni file → path dell'area = cartella troncata a maxDepth. Un file in radice
  //    (senza cartella) diventa un'area col path del file stesso.
  const groups = new Map<string, string[]>();
  for (const file of normalized) {
    const dir = dirOf(file);
    const areaPath = dir === "" ? file : truncateDir(dir, maxDepth);
    const arr = groups.get(areaPath);
    if (arr) arr.push(file);
    else groups.set(areaPath, [file]);
  }

  // 3. Fusione delle aree annidate: se un path copre un altro (prefisso di cartella),
  //    i file confluiscono nell'ANTENATO più corto, così le aree sono DISGIUNTE.
  const paths = Array.from(groups.keys()).sort();
  const merged = new Map<string, Set<string>>();
  for (const p of paths) {
    const ancestor = Array.from(merged.keys()).find((a) => covers(a, p));
    const targetKey = ancestor ?? p;
    let set = merged.get(targetKey);
    if (!set) {
      set = new Set<string>();
      merged.set(targetKey, set);
    }
    for (const f of groups.get(p) ?? []) set.add(f);
  }

  // 4. Consolidamento dei frammenti piccoli: aree SORELLE (stesso genitore di cartella)
  //    ciascuna con MENO di `minGroup` file vengono fuse nel genitore comune — evita una
  //    proliferazione di micro-pagine da un file. Un frammento isolato (senza sorelle
  //    piccole sotto lo stesso genitore) resta autonomo. Non tocca le aree "file in radice".
  consolidateSmallSiblings(merged, minGroup);

  // 5. Materializza aree ordinate; file ordinati e dedupati.
  return Array.from(merged.entries())
    .map(([path, fileSet]) => ({ path, files: Array.from(fileSet).sort() }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Fonde le aree sorelle "piccole" (< `minGroup` file, stesso genitore di cartella) nel
 * loro genitore comune. Muta `merged` in-place. Un genitore vuoto (radice) non è un
 * bersaglio di fusione: i file in radice restano aree a sé.
 */
function consolidateSmallSiblings(merged: Map<string, Set<string>>, minGroup: number): void {
  // Raggruppa i path per genitore di cartella.
  const byParent = new Map<string, string[]>();
  for (const path of merged.keys()) {
    const parent = dirOf(path);
    if (parent === "") continue; // area di 1° livello o file in radice: nessuna fusione.
    const arr = byParent.get(parent);
    if (arr) arr.push(path);
    else byParent.set(parent, [path]);
  }
  for (const [parent, siblings] of byParent) {
    // Solo se ci sono ≥ 2 sorelle, TUTTE piccole (< minGroup): unica micro-pagina per file.
    if (siblings.length < 2) continue;
    const allSmall = siblings.every((s) => (merged.get(s)?.size ?? 0) < minGroup);
    if (!allSmall) continue;
    const target = merged.get(parent) ?? new Set<string>();
    for (const s of siblings) {
      for (const f of merged.get(s) ?? []) target.add(f);
      merged.delete(s);
    }
    merged.set(parent, target);
  }
}

// ── Contratto MINI-ORIENT ────────────────────────────────────────────────────

/** Apre un blocco proposta nel contratto mini-orient. */
export const GROW_PROPOSAL_START_MARKER = "===PROPOSAL===";
/** Chiude un blocco proposta nel contratto mini-orient. */
export const GROW_PROPOSAL_END_MARKER = "===END PROPOSAL===";

/** Prefissi di riga dentro un blocco proposta. */
const TITLE_PREFIX = "title:";
const KIND_PREFIX = "kind:";
const PARENT_PREFIX = "parent:";
const PATHS_PREFIX = "paths:";

/** Tetto difensivo di proposte parsate (il tetto "logico" lo applica il chiamante). */
const MAX_PROPOSALS_CAP = 20;
/** Tetto ragionevole di file elencati per area nel prompt. */
const MAX_FILES_PER_AREA = 50;
/** Tetti di contesto: niente prompt sterminato. */
const MAX_AREAS = 100;
const MAX_PAGES = 300;
const MAX_COMMITS = 200;

/** Albero di appartenenza di una proposta (come `DocTree` in explore). */
export type GrowKind = "technical" | "functional";

/** Una pagina da creare, decisa dal mini-orient. */
export interface GrowProposal {
  /** Titolo della pagina. */
  title: string;
  /** Albero: tecnico (per sviluppatori) o funzionale (per l'utente). */
  kind: GrowKind;
  /** Slug del genitore tra le pagine esistenti, o null per la radice. */
  parentSlug: string | null;
  /** Sottoinsieme dei path dell'area che la pagina documenta. */
  sourcePaths: string[];
}

/** Una pagina esistente passata al mini-orient come possibile genitore/contesto. */
export interface GrowExistingPage {
  slug: string;
  title: string;
  kind: string;
}

/** Input del prompt mini-orient. */
export interface GrowOrientInput {
  /** Aree nuove aggregate (path + file), da documentare. */
  areas: NewArea[];
  /** Pagine esistenti (slug/title/kind) tra cui scegliere il genitore. */
  existingPages: GrowExistingPage[];
  /** Tetto al numero di proposte richieste all'agente. */
  maxPages: number;
  /** Subject dei commit del range, come contesto. */
  commitSubjects: string[];
}

/**
 * Costruisce il prompt del MINI-ORIENT: un singolo run agente (read-only) che, viste
 * le AREE NUOVE del repo e le pagine di documentazione esistenti, decide fino a
 * `maxPages` pagine da creare. Stile degli altri agenti: istruzioni + contratto a
 * marcatori (un blocco `===PROPOSAL===` per pagina), niente formato libero, read-only.
 */
export function buildGrowOrientPrompt(input: GrowOrientInput): string {
  const areasBlock =
    input.areas.length > 0
      ? input.areas
          .slice(0, MAX_AREAS)
          .map((area) => {
            const fileLines = area.files
              .slice(0, MAX_FILES_PER_AREA)
              .map((f) => `    - ${f}`);
            const more =
              area.files.length > MAX_FILES_PER_AREA
                ? [`    - … (+${area.files.length - MAX_FILES_PER_AREA} more files)`]
                : [];
            return [`- AREA ${area.path}:`, ...fileLines, ...more].join("\n");
          })
          .join("\n")
      : "(no new areas)";

  const pages =
    input.existingPages.length > 0
      ? input.existingPages
          .slice(0, MAX_PAGES)
          .map((p) => `- ${p.slug} :: ${p.title} :: ${p.kind}`)
          .join("\n")
      : "(no existing pages)";

  const commits =
    input.commitSubjects.length > 0
      ? input.commitSubjects.slice(0, MAX_COMMITS).map((s) => `- ${s}`).join("\n")
      : "(no commit subjects)";

  return [
    "You are deciding which NEW pages of documentation to create for a software",
    "repository. Some AREAS of the repo (folders/files listed below) are NOT yet covered",
    "by any existing documentation page. You are running READ-ONLY in the repository",
    "working directory: you MAY read the code to judge what each area is about — ground",
    "your decisions in what the code actually does, do not invent.",
    "",
    `Propose AT MOST ${input.maxPages} new page(s). Fewer is fine. Do NOT propose pages for`,
    "areas that are trivial, generated, or not worth a dedicated page.",
    "",
    "NEW AREAS not covered by any documentation page (area path, then its files):",
    areasBlock,
    "",
    "EXISTING DOCUMENTATION PAGES (slug :: title :: kind) — a new page may hang under one",
    "of these as its parent, referenced by its SLUG:",
    pages,
    "",
    "COMMIT SUBJECTS (most recent first), for orientation:",
    commits,
    "",
    "FOR EACH page you propose, decide:",
    "- title: a short, human page title;",
    "- kind: 'technical' (for developers, about the code) or 'functional' (plain,",
    "  non-technical, about what the product does for users);",
    "- parent: the SLUG of an existing page above to nest this page under, or leave it",
    "  EMPTY to place the page at the root;",
    "- paths: the source path(s) this page should document — a sensible subset of the",
    "  area's files/folders, comma-separated.",
    "",
    "OUTPUT CONTRACT — obey this EXACTLY. Emit ONE block per proposed page, each marker",
    "ALONE on its own line, and NOTHING that matters outside the blocks (any other text is",
    "ignored). Fields are `key: value` lines. Emit no proposals at all if none are worth it.",
    "",
    GROW_PROPOSAL_START_MARKER,
    "title: <short page title>",
    "kind: functional",
    "parent: <slug of an existing page, or empty for root>",
    "paths: <path1>, <path2>",
    GROW_PROPOSAL_END_MARKER,
    "",
    "Do NOT save anything to any file and write NOTHING that matters outside the",
    "PROPOSAL markers.",
  ].join("\n");
}

/** Normalizza un path di source: trim, slash iniziali/finali rimossi, collassati. */
function normalizeSourcePath(p: string): string {
  return p
    .trim()
    .split("/")
    .filter((seg) => seg !== "")
    .join("/");
}

/**
 * Parsa l'output del mini-orient in `GrowProposal[]`. BEST-EFFORT, non lancia MAI:
 *  - i blocchi sono estratti a coppie `===PROPOSAL===`/`===END PROPOSAL===` per-riga
 *    (marcatori riconosciuti solo come riga intera); un nuovo `===PROPOSAL===` prima
 *    della chiusura riavvia il blocco (tollera marcatori spezzati/annidati);
 *  - una proposta senza `title` o con `kind` non ∈ {technical, functional} è SCARTATA;
 *  - `parent` vuoto/mancante → `parentSlug: null`;
 *  - `paths` splittati su virgola, normalizzati (trim, senza slash iniziali/finali),
 *    i vuoti scartati; assente → `sourcePaths: []` (proposta comunque valida);
 *  - troncato a un cap difensivo alto (`MAX_PROPOSALS_CAP` = 20); il tetto "logico"
 *    (`maxPages`) lo applica il CHIAMANTE.
 */
export function parseGrowOrientOutput(output: string): GrowProposal[] {
  const proposals: GrowProposal[] = [];
  const lines = output.split("\n");

  let current: string[] | null = null;
  const flush = (): void => {
    if (current === null) return;
    const parsed = parseProposalBlock(current);
    if (parsed) proposals.push(parsed);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === GROW_PROPOSAL_START_MARKER) {
      // Un nuovo start prima della chiusura → il blocco precedente è spezzato: lo si
      // prova comunque (best-effort) e si riparte.
      flush();
      current = [];
      continue;
    }
    if (line === GROW_PROPOSAL_END_MARKER) {
      flush();
      continue;
    }
    if (current !== null) current.push(raw);
  }
  // Blocco non chiuso in coda: prova best-effort.
  flush();

  return proposals.slice(0, MAX_PROPOSALS_CAP);
}

/** Parsa un singolo blocco proposta (righe interne) → `GrowProposal` o null se invalido. */
function parseProposalBlock(blockLines: string[]): GrowProposal | null {
  let title = "";
  let kindRaw = "";
  let parent = "";
  let pathsRaw = "";
  for (const raw of blockLines) {
    const line = raw.trim();
    const lower = line.toLowerCase();
    if (lower.startsWith(TITLE_PREFIX)) title = line.slice(TITLE_PREFIX.length).trim();
    else if (lower.startsWith(KIND_PREFIX)) kindRaw = line.slice(KIND_PREFIX.length).trim();
    else if (lower.startsWith(PARENT_PREFIX)) parent = line.slice(PARENT_PREFIX.length).trim();
    else if (lower.startsWith(PATHS_PREFIX)) pathsRaw = line.slice(PATHS_PREFIX.length).trim();
  }

  if (title === "") return null;
  const kind = kindRaw.toLowerCase();
  if (kind !== "technical" && kind !== "functional") return null;

  const parentSlug = parent === "" ? null : parent;
  const sourcePaths = pathsRaw
    .split(",")
    .map(normalizeSourcePath)
    .filter((p) => p !== "");

  return { title, kind, parentSlug, sourcePaths };
}
