import {
  decrypt,
  docGenerations,
  docPages,
  gitAccounts,
  projects,
  type Db,
} from "@stubwise/db";
import {
  buildReleasePrompt,
  parseReleaseNotes,
  type ExistingPage,
  type ReleaseNotes,
} from "@stubwise/docs-engine";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunner } from "../agent/runner.js";
import type { MirrorManager, MirrorProject } from "../git/mirrors.js";
import {
  loadProviderById,
  loadProviderChain,
  type ResolvedProvider,
} from "../providers/chain.js";

/**
 * AUTO-AGGIORNAMENTO DOCS — Fase 1 (changelog automatico).
 *
 * Quando un pending di `doc_auto_update_jobs` scade (`not_before <= now`), il poller
 * (auto-update-poller.ts) lo RECLAMA in modo atomico (DELETE ... RETURNING) e chiama
 * `runAutoUpdate` nella catena PER-PROGETTO (serializer condiviso col fix e con la
 * doc-generation, così non si sovrappone a un fetch --prune dello stesso progetto).
 *
 * Cosa fa `runAutoUpdate`:
 *  1. carica il progetto (defaultBranch, docAutoUpdateProviderId, currentDocGenerationId);
 *  2. calcola il diff del range (file cambiati + subject dei commit) sul mirror;
 *  3. GATE RUMORE deterministico: se TUTTI i file cambiati sono rumore (lockfile,
 *     cartelle di processo/doc) o non c'è alcun file → niente agente, niente entry;
 *  4. risolve il provider (provider bloccato per id, oppure chain[0]); provider auto
 *     impostato ma non risolvibile → log e termina SENZA fallback;
 *  5. un agente di analisi (1 run, contesto TESTUALE del diff, NESSUN worktree — in
 *     Fase 1 non si rigenera codice) produce le note di rilascio col contratto a
 *     marcatori (significatività + titolo + body markdown + slug impattati);
 *  6. inserisce una pagina `doc_pages` PERSISTENTE (generationId null, come le manuali)
 *     kind="releases", con cross-link "related" verso gli slug esistenti impattati;
 *  7. avanza `doc_generations.commitSha` della generazione corrente a `toSha`.
 *
 * SCELTE (Fase 1):
 *  - NESSUN worktree per l'agente: il diff/commit/pagine sono passati come contesto
 *    testuale. Più semplice e robusto (niente apertura/chiusura worktree, niente mutua
 *    esclusione aggiuntiva col mirror); basta perché qui non si rigenera codice.
 *  - NIENTE embedding della pagina release: la entry NON viene chunk+embeddata (la
 *    ricerca semantica resta sui docs generati). È documentato e demandato a una fase
 *    successiva se servisse.
 *  - BEST-EFFORT / IDEMPOTENTE: il pending è GIÀ stato reclamato (rimosso) dal poller
 *    prima di chiamare l'handler. Se l'handler fallisce a metà, quel ciclo è perso ma
 *    il job NON torna in loop: il prossimo push ricreerà un pending col toSha aggiornato.
 */

/** Forma attesa delle credenziali git decifrate (mirror di orient-handler). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

/** Riga di pending reclamata dal poller, passata all'handler. */
export interface AutoUpdateJob {
  id: string;
  projectId: string;
  fromSha: string;
  toSha: string;
}

export interface RunAutoUpdateDeps {
  db: Db;
  mirrors: MirrorManager;
  runner: AgentRunner;
  /** Chiave AES-256 per decifrare le credenziali dell'account git. */
  encryptionKey: Buffer;
  /** Modello AI dell'agente di analisi (config.docGenerationModel). */
  model: string;
  /** Timeout (ms) del run dell'agente (config.docAgentTimeoutMs). */
  agentTimeoutMs: number;
  /** Turni massimi del run dell'agente (config.docModuleMaxTurns). */
  maxTurns: number;
  /** Risolutore di UN provider per id (iniettabile nei test). Default: loadProviderById. */
  loadProviderByIdFn?: (
    db: Db,
    encryptionKey: Buffer,
    id: string,
  ) => Promise<ResolvedProvider | null>;
  /** Caricatore della catena di provider (iniettabile nei test). Default: loadProviderChain. */
  loadProviderChainFn?: (db: Db, encryptionKey: Buffer) => Promise<ResolvedProvider[]>;
}

/**
 * Lockfile (changeset di solo rumore se sono i soli a cambiare): l'aggiornamento di un
 * lockfile da solo non è materiale per un changelog.
 */
const LOCKFILE_BASENAMES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]);

/**
 * Cartelle top-level di RUMORE escluse dal changelog: gli stessi artefatti di sessione/
 * processo che l'orientamento (packages/docs-engine/src/recursive/orient.ts) esclude dal
 * tecnico — note di pianificazione, design, manuali, guide — più la cartella CI `.github`.
 * Un file sotto una di queste cartelle non è una modifica di prodotto materiale per la
 * entry release. Lista DUPLICATA volutamente (qui è un gate deterministico, non il prompt
 * dell'agente di orientamento) e tenuta in sync con quella.
 */
const NOISE_DIR_PREFIXES = [
  "plans/",
  "docs/",
  "manual/",
  "guides/",
  ".github/",
];

/**
 * true se `path` è RUMORE per il changelog: un lockfile (per basename, ovunque sia) o un
 * file annidato in una cartella di rumore (per prefisso di path normalizzato).
 */
export function isNoise(path: string): boolean {
  const normalized = path.trim().replace(/^\/+/, "");
  if (normalized === "") return true;
  const slash = normalized.lastIndexOf("/");
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
  if (LOCKFILE_BASENAMES.has(basename)) return true;
  return NOISE_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Sha breve (7 char) per lo slug della release; tollera sha più corti. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Timestamp `YYYYMMDD-HHmm` (UTC) per lo slug della release. */
function timestampForSlug(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
  );
}

/** Contesto del progetto necessario all'auto-update. */
interface ProjectContext {
  mirrorProject: MirrorProject;
  docAutoUpdateProviderId: string | null;
  currentDocGenerationId: string | null;
}

/**
 * Carica il progetto + l'account git e decifra le credenziali per costruire il
 * MirrorProject. Ritorna null (con log) se il progetto/account non c'è o le credenziali
 * non si decifrano: l'auto-update è best-effort, non c'è un job da fallire.
 */
async function loadProjectContext(
  deps: RunAutoUpdateDeps,
  projectId: string,
): Promise<ProjectContext | null> {
  const [row] = await deps.db
    .select({ project: projects, account: gitAccounts })
    .from(projects)
    .innerJoin(gitAccounts, eq(projects.gitAccountId, gitAccounts.id))
    .where(eq(projects.id, projectId));
  if (!row) {
    console.error(
      `[stubwise-worker] auto-update: progetto ${projectId} o account git collegato non trovato, salto`,
    );
    return null;
  }
  const { project, account } = row;

  let credentials: z.infer<typeof credentialsSchema>;
  try {
    credentials = credentialsSchema.parse(
      JSON.parse(decrypt(account.encryptedCredentials, deps.encryptionKey)),
    );
  } catch {
    console.error(
      `[stubwise-worker] auto-update: credenziali git del progetto ${projectId} non decifrabili, salto`,
    );
    return null;
  }

  return {
    mirrorProject: {
      provider: project.provider,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
      credentials,
    },
    docAutoUpdateProviderId: project.docAutoUpdateProviderId,
    currentDocGenerationId: project.currentDocGenerationId,
  };
}

/** Carica le pagine esistenti della generazione corrente (contesto per l'agente + link). */
async function loadExistingPages(
  db: Db,
  generationId: string | null,
): Promise<ExistingPage[]> {
  if (generationId === null) return [];
  const rows = await db
    .select({
      slug: docPages.slug,
      title: docPages.title,
      sourcePath: docPages.sourcePath,
    })
    .from(docPages)
    .where(eq(docPages.generationId, generationId));
  return rows.map((r) => ({ slug: r.slug, title: r.title, sourcePath: r.sourcePath }));
}

/**
 * Risolve il provider AI dell'auto-update:
 *  - con `docAutoUpdateProviderId`: SOLO quel provider (provider "bloccato"). Se non è
 *    risolvibile (disabilitato/cancellato/segreto non decifrabile) ritorna
 *    `{ blocked: true }` → l'handler termina SENZA fallback;
 *  - senza id (automatico): la prima voce della catena (come la generazione normale).
 *    Catena vuota → `provider` undefined (auth storica del container).
 */
async function resolveProvider(
  deps: RunAutoUpdateDeps,
  docAutoUpdateProviderId: string | null,
): Promise<{ provider: ResolvedProvider | undefined } | { blocked: true }> {
  if (docAutoUpdateProviderId) {
    const loadById = deps.loadProviderByIdFn ?? loadProviderById;
    const pinned = await loadById(deps.db, deps.encryptionKey, docAutoUpdateProviderId);
    if (!pinned) return { blocked: true };
    return { provider: pinned };
  }
  const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
  const chain = await loadChain(deps.db, deps.encryptionKey);
  return { provider: chain[0] };
}

/**
 * Costruisce uno slug univoco per la release: `release-<YYYYMMDD-HHmm>-<shortSha>`. Se
 * collide con una pagina release già esistente (stesso minuto + stesso sha breve) appende
 * un suffisso numerico. Lo slug è univoco tra le pagine PERSISTENTI (generation_id null)
 * del progetto (vincolo parziale doc_pages_manual_slug_unique).
 */
async function uniqueReleaseSlug(
  db: Db,
  projectId: string,
  toSha: string,
  now: Date,
): Promise<string> {
  const base = `release-${timestampForSlug(now)}-${shortSha(toSha)}`;
  let slug = base;
  let suffix = 1;
  // Loop limitato: in pratica al massimo una/due iterazioni (collisione = doppio push
  // nello stesso minuto sullo stesso sha breve, raro).
  for (let i = 0; i < 100; i++) {
    const [existing] = await db
      .select({ id: docPages.id })
      .from(docPages)
      .where(
        and(
          eq(docPages.projectId, projectId),
          eq(docPages.slug, slug),
          isNull(docPages.generationId),
        ),
      );
    if (!existing) return slug;
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  // Fallback estremo: aggiungi un componente casuale (non dovrebbe mai servire).
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Risolve gli `affectedSlugs` dell'agente in cross-link "related": tiene solo gli slug
 * che ESISTONO tra le pagine esistenti (scarta quelli inventati), risolve il titolo e
 * deduplica. Formato del campo `links` (jsonb): array `{ type, slug, title }`.
 */
function buildRelatedLinks(
  affectedSlugs: string[],
  existingPages: ExistingPage[],
): { type: "related"; slug: string; title: string }[] {
  const bySlug = new Map(existingPages.map((p) => [p.slug, p.title]));
  const seen = new Set<string>();
  const links: { type: "related"; slug: string; title: string }[] = [];
  for (const slug of affectedSlugs) {
    const title = bySlug.get(slug);
    if (title === undefined || seen.has(slug)) continue;
    seen.add(slug);
    links.push({ type: "related", slug, title });
  }
  return links;
}

/**
 * Esegue l'auto-update per un pending GIÀ RECLAMATO (rimosso dalla tabella dal poller).
 * Best-effort: ogni percorso d'uscita logga e termina; un errore NON rimette in loop il
 * pending (non esiste più). Vedi il docblock del modulo per il flusso completo.
 */
export async function runAutoUpdate(deps: RunAutoUpdateDeps, job: AutoUpdateJob): Promise<void> {
  const ctx = await loadProjectContext(deps, job.projectId);
  if (!ctx) return;

  // Diff del range: file cambiati + subject dei commit. Se gli sha non sono raggiungibili
  // (es. force-push che ha riscritto la history, mirror non aggiornato) il git fallisce →
  // log e termina (best-effort, il prossimo push ricreerà un pending).
  let changed: string[];
  let commitSubjects: string[];
  try {
    changed = await deps.mirrors.getChangedFiles(ctx.mirrorProject, job.fromSha, job.toSha);
    const commits = await deps.mirrors.getCommitMessages(
      ctx.mirrorProject,
      job.fromSha,
      job.toSha,
    );
    commitSubjects = commits.map((c) => c.subject);
  } catch (err) {
    console.error(
      `[stubwise-worker] auto-update: diff ${job.fromSha}..${job.toSha} del progetto ${job.projectId} fallito (${errText(err)}), salto`,
    );
    return;
  }

  // GATE RUMORE (deterministico): se TUTTI i file cambiati sono rumore (o non c'è alcun
  // file) niente è materiale per un changelog → niente agente, niente entry. Il pending è
  // già stato reclamato, quindi non si ricrea nulla. Lo `commitSha` della generazione NON
  // avanza qui di proposito: il prossimo push utile partirà da un fromSha che include
  // anche questi commit di rumore (sono nel suo range, ma resteranno comunque filtrati).
  const material = changed.filter((path) => !isNoise(path));
  if (material.length === 0) {
    console.error(
      `[stubwise-worker] auto-update: progetto ${job.projectId} ${job.fromSha}..${job.toSha} è solo rumore (${changed.length} file), nessuna entry release`,
    );
    return;
  }

  // Provider: bloccato (per id) o automatico (chain[0]). Bloccato non risolvibile → stop
  // senza fallback (coerente col "provider bloccato" della generazione).
  const resolved = await resolveProvider(deps, ctx.docAutoUpdateProviderId);
  if ("blocked" in resolved) {
    console.error(
      `[stubwise-worker] auto-update: provider auto del progetto ${job.projectId} non disponibile (disabilitato/cancellato), salto senza fallback`,
    );
    return;
  }

  const existingPages = await loadExistingPages(deps.db, ctx.currentDocGenerationId);

  // Agente di analisi: 1 run, contesto TESTUALE (niente worktree in Fase 1). plan =
  // read-only (l'agente non scrive nulla, produce solo l'output marcato).
  const prompt = buildReleasePrompt({
    changedFiles: material,
    commitSubjects,
    existingPages,
  });
  let notes: ReleaseNotes | null;
  try {
    const result = await deps.runner.run({
      cwd: process.cwd(),
      prompt,
      model: deps.model,
      permissionMode: "plan",
      maxTurns: deps.maxTurns,
      timeoutMs: deps.agentTimeoutMs,
      ...(resolved.provider !== undefined ? { provider: resolved.provider } : {}),
    });
    notes = parseReleaseNotes(result.output);
  } catch (err) {
    console.error(
      `[stubwise-worker] auto-update: agente di release del progetto ${job.projectId} fallito (${errText(err)}), nessuna entry`,
    );
    return;
  }
  if (!notes) {
    console.error(
      `[stubwise-worker] auto-update: output dell'agente di release del progetto ${job.projectId} non valido (marcatori mancanti), nessuna entry`,
    );
    return;
  }

  // Entry release: pagina PERSISTENTE (generationId null, come le manuali). Titolo col
  // prefisso "[minore]" quando NON significativa; position decrescente nel tempo così le
  // più recenti sono in cima all'albero.
  const now = new Date();
  const slug = await uniqueReleaseSlug(deps.db, job.projectId, job.toSha, now);
  const title = notes.significant ? notes.title : `[minore] ${notes.title}`;
  const links = buildRelatedLinks(notes.affectedSlugs, existingPages);

  try {
    await deps.db.insert(docPages).values({
      projectId: job.projectId,
      generationId: null,
      kind: "releases",
      isManual: false,
      slug,
      title,
      parentId: null,
      position: -Math.floor(now.getTime() / 1000),
      sourcePath: null,
      body: notes.body,
      links: links.length > 0 ? links : null,
    });
  } catch (err) {
    console.error(
      `[stubwise-worker] auto-update: insert della entry release del progetto ${job.projectId} fallito (${errText(err)})`,
    );
    return;
  }

  // I docs sono ora "visti fino a" toSha: avanza il commitSha della generazione corrente.
  // Se non c'è una generazione corrente, salta (niente puntatore da aggiornare).
  if (ctx.currentDocGenerationId !== null) {
    try {
      await deps.db
        .update(docGenerations)
        .set({ commitSha: job.toSha })
        .where(eq(docGenerations.id, ctx.currentDocGenerationId));
    } catch (err) {
      console.error(
        `[stubwise-worker] auto-update: aggiornamento commitSha della generazione ${ctx.currentDocGenerationId} fallito (${errText(err)})`,
      );
      // L'entry è già creata: non è un fallimento dell'auto-update.
    }
  }

  console.error(
    `[stubwise-worker] auto-update: entry release '${slug}' creata per il progetto ${job.projectId} (significant=${notes.significant}, ${links.length} link)`,
  );
}
