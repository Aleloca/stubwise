import { pluginJobs, plugins, projectPlugins, type Db, type PluginJob, type PluginRow } from "@stubwise/db";
import type { PluginInventory } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import { execa } from "execa";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { ClaudeCliRunner } from "../agent/claude-cli.js";
import type { AgentRunner } from "../agent/runner.js";
import { loadProviderChain } from "../providers/chain.js";
import { basePluginPath } from "./base.js";
import { fetchAtRef } from "./git.js";
import { readInventory } from "./inventory.js";
import {
  claimNextPluginJob,
  completePluginJob,
  failPluginJob,
  MAX_PLUGIN_ATTEMPTS,
  PLUGIN_STALE_MINUTES,
  recoverStalePluginJobs,
} from "./queue.js";

/**
 * POLLER della coda `plugin_jobs`: task SEPARATO dal loop dei job (stesso
 * pattern di graph/poller.ts, pulse/poller.ts), su un proprio intervallo.
 *
 * Due kind, due lavori distinti:
 *
 *  - `materialize`: fetch del repo del plugin al `ref` richiesto, guard sui
 *    symlink, `claude plugin validate --strict`, inventario, pubblicazione
 *    della dir sul volume e passaggio a `ready`. È il produttore di
 *    `<PLUGINS_DIR>/<slug>/<sha>/`.
 *  - `smoke`: un run minimo dell'agente col plugin caricato, per verificare che
 *    le sue skill siano DAVVERO visibili al CLI (un plugin materializzato ma
 *    invisibile sarebbe un no-op silenzioso nei run).
 *
 * NIENTE SERIALIZER per-progetto, a differenza del grafo: il registro è
 * d'istanza e non tocca né i mirror né i worktree dei progetti. La mutua
 * esclusione che serve — due materializzazioni concorrenti della stessa
 * directory — la dà già l'indice unico parziale su `(plugin_id, kind)` per gli
 * stati vivi (vedi queue.ts).
 *
 * DIVISIONE COL RUNNER: i runner qui sotto LANCIANO in caso di errore e il
 * poller chiude il job (`failed` + riflesso sullo stato del plugin, vedi
 * `failPluginJob`). Nessun runner scrive lo stato di fallimento da sé: così
 * esiste UN SOLO punto in cui un errore diventa testo nel DB, ed è quello che
 * lo sanitizza.
 *
 * BEST-EFFORT come gli altri poller: non fa MAI crashare il worker (ogni job in
 * try/catch isolato, e il tick a sua volta). Si ferma sull'AbortSignal.
 */

/**
 * Budget COMPLESSIVO del fetch git di una materializzazione (fallback a fetch
 * pieno incluso: vedi `fetchAtRef`, che condivide una sola scadenza fra tutti i
 * comandi). Dimensionato per un clone COMPLETO di un repo di plugin su rete
 * lenta, non per uno shallow: il fallback scatta proprio quando lo shallow non
 * è possibile (ref-sha non pubblicizzato), ed è il caso più lento.
 */
export const MATERIALIZE_TIMEOUT_MS = 10 * 60_000;

/** Timeout di `claude plugin validate`: è un controllo statico, non un run. */
export const VALIDATE_TIMEOUT_MS = 60_000;

/** Timeout dello smoke run: un turno solo su un modello economico. */
export const SMOKE_TIMEOUT_MS = 120_000;

/** Modello dello smoke: verifica di visibilità, non di capacità. */
const SMOKE_MODEL = "haiku";
const SMOKE_MAX_TURNS = 1;

/**
 * Prompt fisso dello smoke. In inglese come quello del credential tester (è
 * rivolto al modello, non all'utente) e volutamente banale: si chiede SOLO
 * l'elenco, perché l'unica cosa da verificare è che il CLI abbia caricato il
 * plugin e ne esponga le skill col namespace atteso.
 */
const SMOKE_PROMPT =
  "List the names of every skill available to you, one per line, exactly as they are " +
  "namespaced (for example `plugin-name:skill-name`). Output only the list.";

/** Tetto dell'output dell'agente riportato in `smoke_error` (il resto è rumore). */
const SMOKE_OUTPUT_MAX_CHARS = 2000;

// ---------------------------------------------------------------------------
// Validate (iniettabile)
// ---------------------------------------------------------------------------

/** Esito di `claude plugin validate <dir> --strict`. */
export interface PluginValidationResult {
  ok: boolean;
  /** Output del comando (stdout+stderr), usato come messaggio d'errore. */
  output: string;
}

/** Validatore di una dir di plugin. Iniettabile: nessun test lancia il CLI vero. */
export type ValidatePluginFn = (pluginDir: string) => Promise<PluginValidationResult>;

/**
 * Validatore di produzione: shella sul CLI `claude`. Non lancia mai — un exit
 * non-zero È il risultato ("plugin non valido"), e anche un binario mancante o
 * un timeout diventano un esito negativo con la diagnosi dentro `output`:
 * questa è una verifica sul plugin, e ogni suo modo di non riuscire deve
 * apparire all'admin come "materializzazione fallita, ecco perché".
 */
export function createClaudeValidator(
  claudePath = "claude",
  timeoutMs = VALIDATE_TIMEOUT_MS,
): ValidatePluginFn {
  return async (pluginDir: string): Promise<PluginValidationResult> => {
    try {
      const { all } = await execa(claudePath, ["plugin", "validate", pluginDir, "--strict"], {
        timeout: timeoutMs,
        forceKillAfterDelay: 5000,
        all: true,
      });
      return { ok: true, output: (all ?? "").trim() };
    } catch (error) {
      const e = error as {
        all?: string;
        stdout?: string;
        stderr?: string;
        timedOut?: boolean;
        shortMessage?: string;
      };
      const output = (e.all ?? e.stderr ?? e.stdout ?? e.shortMessage ?? "").trim();
      return {
        ok: false,
        output: e.timedOut === true ? `timeout dopo ${timeoutMs}ms\n${output}`.trim() : output,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Logger minimo (stessa forma di quello del poller del grafo). */
export interface PluginPollerLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface PluginPollerDeps {
  db: Db;
  /** Radice del volume dei plugin: `<pluginsDir>/<slug>/<sha>/`. */
  pluginsDir: string;
  /** Chiave di cifratura: serve a risolvere la catena dei provider per lo smoke. */
  encryptionKey: Buffer;
  logger: PluginPollerLogger;
  /** Runner dell'agente per lo smoke. Default: ClaudeCliRunner. */
  runner?: AgentRunner;
  /** Validatore del plugin. Default: `createClaudeValidator()`. */
  validatePluginFn?: ValidatePluginFn;
  /** Fetch git del plugin. Default: `fetchAtRef` (allowlist di produzione). */
  fetchAtRefFn?: typeof fetchAtRef;
  /** Path del plugin base. Default: `basePluginPath`. */
  basePluginPathFn?: () => string | null;
  /** Catena dei provider AI. Default: `loadProviderChain`. */
  loadProviderChainFn?: typeof loadProviderChain;
  /** Stop cooperativo: interrompe il drain a metà tick. */
  signal?: AbortSignal;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/** `true` se il path è una directory REALE (`lstat`: un symlink non conta). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Un solo segmento di path sicuro: niente separatori, niente `.`/`..`, niente
 * caratteri esotici. Vale per lo `slug` del plugin e per il suo sha risolto,
 * che questo modulo concatena a `PLUGINS_DIR` per ottenere una directory.
 *
 * Perché qui: le colonne del registro non hanno CHECK e lo slug lo deriva il
 * SERVER (Task 8). Questo modulo è l'unico punto in cui quelle stringhe
 * diventano un path del filesystem del worker — uno slug come `../..` farebbe
 * uscire dal volume una `rm -rf` e una `rename`. È la stessa logica di
 * `assertNotOption` in git.ts: il chiamante è fidato, ma il controllo costa
 * nulla e la conseguenza di sbagliarsi è enorme.
 */
function assertSafeSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} non utilizzabile come nome di directory: ${JSON.stringify(value)}`);
  }
}

/**
 * Sottocartella del plugin dentro la checkout: percorso relativo normalizzato,
 * stessa regola dello schema condiviso (`pluginSourceSubdirSchema`). Ripetuta
 * qui perché lo schema protegge l'INGRESSO dell'API, mentre questo modulo legge
 * dal DB — dove una riga può essere finita per altre strade (import, fix a
 * mano, una versione futura del server).
 */
function assertSafeSubdir(value: string): void {
  const segments = value.split("/");
  if (value.includes("\\") || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`Sottocartella non valida: ${JSON.stringify(value)}`);
  }
}

/**
 * GUARD AUTOREVOLE sui symlink: rifiuta l'intero albero materializzato se
 * contiene anche un solo link simbolico.
 *
 * Perché rifiutare invece di neutralizzare (rimuovere i link e proseguire): la
 * dir di un plugin è codice di terze parti che finisce COPIATO nella dir
 * temporanea di ogni run e passato al CLI con `--plugin-dir`. Un link che esce
 * dalla dir del plugin dà al processo dell'agente lettura (ed esecuzione) di
 * file dell'host del worker. Rimuoverli in silenzio produrrebbe un plugin
 * MUTILATO ma dichiarato `ready`: si comporterebbe in modo diverso da quello
 * che l'admin ha letto sul repo sorgente, e nessuno saprebbe perché. Meglio un
 * fallimento esplicito con il path incriminato: se il plugin ha davvero bisogno
 * di un link, va sistemato alla sorgente.
 *
 * Il controllo gira sull'INTERA checkout (non solo su `sourceSubdir`) e PRIMA di
 * validate, inventario e pubblicazione: nulla di ciò che sta a valle deve mai
 * vedere un albero con link dentro. È il choke point che protegge tutti i
 * consumatori; le difese in profondità di `inventory.ts` restano dov'erano.
 */
async function assertNoSymlinks(root: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    // `withFileTypes` usa la semantica di lstat: un symlink a directory è
    // `isSymbolicLink()` e NON `isDirectory()`, quindi la ricorsione non lo
    // segue mai (niente cicli, niente uscite dall'albero).
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `L'albero del plugin contiene un symlink, non ammesso: ${relative(root, full)}`,
        );
      }
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(root);
}

// ---------------------------------------------------------------------------
// materialize
// ---------------------------------------------------------------------------

/**
 * Materializza il plugin: fetch → guard symlink → validate → inventario →
 * pubblicazione della dir → `ready` → potature → smoke accodato.
 *
 * DIR TEMPORANEA: lo sha si conosce solo DOPO il fetch, quindi non si può
 * fetchare direttamente in `<slug>/<sha>`. Si usa `<slug>/.tmp-<jobId>`, che
 * viene ripulita PRIMA dell'uso (`fetchAtRef` non ripulisce da sé: un tentativo
 * fallito a metà lascia una checkout parziale) e rimossa nel `finally`. Un
 * worker morto qui lascia una `.tmp-*` orfana: la ripulisce la potatura del
 * primo `ready` successivo, che rimuove dallo slug tutto ciò che non è lo sha
 * corrente.
 *
 * COSA VIENE PUBBLICATO: `<slug>/<sha>` è SEMPRE la dir del plugin, anche con
 * `sourceSubdir` — si pubblica la sottocartella, non la checkout intera. Così
 * chi consuma il volume (la copia filtrata per-run, Task 7) non deve conoscere
 * il subdir, e del monorepo sorgente non resta niente sul volume.
 */
async function runMaterialize(
  deps: PluginPollerDeps,
  job: PluginJob,
  plugin: PluginRow,
): Promise<void> {
  assertSafeSegment(plugin.slug, "Lo slug del plugin");
  if (plugin.sourceSubdir) assertSafeSubdir(plugin.sourceSubdir);

  const slugDir = join(deps.pluginsDir, plugin.slug);
  const tmpDir = join(slugDir, `.tmp-${job.id}`);

  // Stato osservabile: la materializzazione è partita. L'errore precedente si
  // azzera qui (invariante: `error` non-null SOLO con `status = 'failed'`).
  await deps.db
    .update(plugins)
    .set({ status: "materializing", error: null, updatedAt: sql`now()` })
    .where(eq(plugins.id, plugin.id));

  try {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(slugDir, { recursive: true });

    const fetch = deps.fetchAtRefFn ?? fetchAtRef;
    // Ogni errore di `fetchAtRef` è già redatto: può finire dritto nel DB.
    const { sha } = await fetch(plugin.sourceUrl, plugin.ref, tmpDir, {
      timeoutMs: MATERIALIZE_TIMEOUT_MS,
    });

    await assertNoSymlinks(tmpDir);

    const source = plugin.sourceSubdir ? join(tmpDir, plugin.sourceSubdir) : tmpDir;
    if (!(await isDirectory(source))) {
      throw new Error(
        `La sottocartella "${plugin.sourceSubdir}" non esiste nella checkout di "${plugin.ref}"`,
      );
    }

    const validate = deps.validatePluginFn ?? createClaudeValidator();
    const validation = await validate(source);
    if (!validation.ok) {
      throw new Error(
        `\`claude plugin validate --strict\` ha bocciato il plugin:\n${validation.output}`,
      );
    }

    // Inventario PRIMA della pubblicazione: se il manifest è inutilizzabile la
    // dir non viene mai pubblicata (nulla a valle vedrà uno sha senza inventario).
    const inventory = await readInventory(source);

    // Pubblicazione. Ri-materializzare lo STESSO sha sovrascrive la dir: c'è una
    // finestra in cui una copia per-run concorrente non trova i file, e in quel
    // caso il run salta il plugin e prosegue (fail-open documentato in Task 7).
    const pluginDir = join(slugDir, sha);
    await rm(pluginDir, { recursive: true, force: true });
    await rename(source, pluginDir);

    await deps.db
      .update(plugins)
      .set({
        status: "ready",
        resolvedSha: sha,
        inventory,
        materializedAt: sql`now()`,
        error: null,
        // Lo smoke precedente riguardava lo sha VECCHIO: non è più un'informazione
        // sul plugin in uso. Torna `idle` e sarà il job qui sotto a portarlo a
        // `pending`.
        smokeStatus: "idle",
        smokeError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(plugins.id, plugin.id));

    // Da qui in poi il plugin È materializzato: nessun errore deve più farlo
    // fallire. Potature e accodamento sono best-effort e solo loggati.
    await pruneShaDirs(deps, slugDir, sha, plugin.slug);
    await pruneEnablements(deps, plugin, inventory);
    await enqueueSmoke(deps, plugin);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Rimuove dallo slug ogni dir che non sia lo sha corrente (sha vecchi, `.tmp-*` orfane). */
async function pruneShaDirs(
  deps: PluginPollerDeps,
  slugDir: string,
  currentSha: string,
  slug: string,
): Promise<void> {
  try {
    for (const entry of await readdir(slugDir)) {
      if (entry === currentSha) continue;
      await rm(join(slugDir, entry), { recursive: true, force: true });
      deps.logger.info({ slug, removed: entry }, "[plugins] rimossa una dir non più in uso");
    }
  } catch (err) {
    deps.logger.warn({ err, slug }, "[plugins] potatura delle dir vecchie fallita");
  }
}

/**
 * Pota gli spegnimenti per-progetto che citano skill o hook SPARITI dal nuovo
 * inventario. Senza questo, una voce rimasta orfana resterebbe salvata per
 * sempre e — se il plugin un giorno reintroducesse quel nome — tornerebbe ad
 * applicarsi da sola, spegnendo qualcosa che nessuno ha chiesto di spegnere.
 * Solo le righe che cambiano davvero vengono riscritte (e `updated_at` con
 * loro: la colonna non ha `$onUpdate`).
 */
async function pruneEnablements(
  deps: PluginPollerDeps,
  plugin: PluginRow,
  inventory: PluginInventory,
): Promise<void> {
  try {
    const skills = new Set(inventory.skills.map((s) => s.name));
    const hooks = new Set(inventory.hooks.map((h) => h.key));
    const rows = await deps.db
      .select()
      .from(projectPlugins)
      .where(eq(projectPlugins.pluginId, plugin.id));

    for (const row of rows) {
      const nextSkills = row.disabledSkills.filter((name) => skills.has(name));
      const nextHooks = row.disabledHooks.filter((key) => hooks.has(key));
      // `filter` può solo togliere: confrontare le lunghezze basta.
      if (
        nextSkills.length === row.disabledSkills.length &&
        nextHooks.length === row.disabledHooks.length
      ) {
        continue;
      }
      await deps.db
        .update(projectPlugins)
        .set({ disabledSkills: nextSkills, disabledHooks: nextHooks, updatedAt: sql`now()` })
        .where(
          and(
            eq(projectPlugins.projectId, row.projectId),
            eq(projectPlugins.pluginId, plugin.id),
          ),
        );
      deps.logger.info(
        {
          slug: plugin.slug,
          projectId: row.projectId,
          skills: row.disabledSkills.filter((name) => !skills.has(name)),
          hooks: row.disabledHooks.filter((key) => !hooks.has(key)),
        },
        "[plugins] potati spegnimenti che citavano voci non più presenti nell'inventario",
      );
    }
  } catch (err) {
    deps.logger.warn({ err, slug: plugin.slug }, "[plugins] potatura degli spegnimenti fallita");
  }
}

/**
 * Accoda lo smoke della versione appena materializzata. `onConflictDoNothing`
 * per l'indice unico parziale: se uno smoke è già attivo si tiene quello (girerà
 * sullo sha nuovo, che è già quello scritto nel registro). `smoke_status` passa a
 * `pending` SOLO se il job è stato davvero inserito, così non resta mai un
 * `pending` senza nessuno che lo risolva.
 */
async function enqueueSmoke(deps: PluginPollerDeps, plugin: PluginRow): Promise<void> {
  try {
    const inserted = await deps.db
      .insert(pluginJobs)
      .values({ pluginId: plugin.id, kind: "smoke" })
      .onConflictDoNothing()
      .returning({ id: pluginJobs.id });
    if (inserted.length === 0) return;
    await deps.db
      .update(plugins)
      .set({ smokeStatus: "pending", smokeError: null, updatedAt: sql`now()` })
      .where(eq(plugins.id, plugin.id));
  } catch (err) {
    deps.logger.warn({ err, slug: plugin.slug }, "[plugins] accodamento dello smoke fallito");
  }
}

// ---------------------------------------------------------------------------
// smoke
// ---------------------------------------------------------------------------

/**
 * Smoke run: carica il plugin nel CLI e verifica che ogni skill dell'inventario
 * compaia col namespace atteso (`<plugin.json name>:<skill>`).
 *
 * Forma del run (la stessa dei run veri, in miniatura): modello economico, UN
 * turno, `--setting-sources ""` per azzerare ogni altra sorgente (plugin
 * dell'utente, `.claude` della cwd, `.mcp.json`) e `--plugin-dir` col plugin
 * BASE per primo e poi il plugin sotto esame, INTEGRALE — qui non si applica
 * nessun filtro per progetto: lo smoke risponde a "il CLI lo carica?", non a
 * "cosa vede un dato progetto".
 */
async function runSmoke(
  deps: PluginPollerDeps,
  _job: PluginJob,
  plugin: PluginRow,
): Promise<void> {
  const inventory = plugin.inventory;
  if (plugin.status !== "ready" || !plugin.resolvedSha || !inventory) {
    throw new Error("Il plugin non è materializzato: nessuno smoke da eseguire");
  }
  assertSafeSegment(plugin.slug, "Lo slug del plugin");
  assertSafeSegment(plugin.resolvedSha, "Lo sha risolto del plugin");

  await deps.db
    .update(plugins)
    .set({ smokeStatus: "pending", smokeError: null, updatedAt: sql`now()` })
    .where(eq(plugins.id, plugin.id));

  const pluginDir = join(deps.pluginsDir, plugin.slug, plugin.resolvedSha);
  if (!(await isDirectory(pluginDir))) {
    throw new Error(
      `La directory materializzata non esiste più (${plugin.slug}/${plugin.resolvedSha}): rimaterializza il plugin`,
    );
  }

  // Base assente = immagine buildata a metà (vedi base.ts, che degrada a null di
  // proposito). Lo smoke gira lo stesso SENZA base: la domanda a cui risponde
  // riguarda le skill di QUESTO plugin, e farlo fallire per un difetto
  // dell'immagine sarebbe un falso negativo sul plugin.
  const base = (deps.basePluginPathFn ?? basePluginPath)();
  if (!base) {
    deps.logger.warn(
      { slug: plugin.slug },
      "[plugins] plugin base non trovato: smoke eseguito senza",
    );
  }

  // Provider: primo della catena globale (il registro è d'istanza, non ha un
  // progetto da cui ereditare un pin). Catena vuota = auth di default del
  // container, come per il resto del worker.
  const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
  const chain = await loadChain(deps.db, deps.encryptionKey);
  const provider = chain[0];

  const runner = deps.runner ?? new ClaudeCliRunner();
  const result = await runner.run({
    // La cwd non è significativa (`--setting-sources ""` ignora tutto ciò che
    // sta intorno): quella del worker, come nel credential tester.
    cwd: process.cwd(),
    prompt: SMOKE_PROMPT,
    model: SMOKE_MODEL,
    permissionMode: "default",
    maxTurns: SMOKE_MAX_TURNS,
    timeoutMs: SMOKE_TIMEOUT_MS,
    settingSources: "",
    pluginDirs: base ? [base, pluginDir] : [pluginDir],
    ...(provider ? { provider } : {}),
  });

  const expected = inventory.skills.map((skill) => `${inventory.name}:${skill.name}`);
  // Confronto case-insensitive: il modello riscrive l'elenco a modo suo, e
  // pretendere il case esatto trasformerebbe una formattazione in un guasto.
  const haystack = result.output.toLowerCase();
  const missing = expected.filter((name) => !haystack.includes(name.toLowerCase()));

  if (result.exitCode === 0 && missing.length === 0) {
    await deps.db
      .update(plugins)
      .set({ smokeStatus: "passed", smokeError: null, updatedAt: sql`now()` })
      .where(eq(plugins.id, plugin.id));
    return;
  }

  // Difesa in profondità come nel credential tester: il segreto del provider non
  // deve MAI comparire nell'output riportato in UI.
  let output = result.output.trim();
  if (provider && provider.secret.length > 0) output = output.split(provider.secret).join("***");
  if (output.length > SMOKE_OUTPUT_MAX_CHARS) {
    output = `${output.slice(0, SMOKE_OUTPUT_MAX_CHARS)}…`;
  }
  const reason =
    missing.length > 0
      ? `Skill non visibili all'agente: ${missing.join(", ")}`
      : `Il CLI è uscito con exit ${result.exitCode}`;
  throw new Error(
    `${reason} (attese: ${expected.join(", ") || "nessuna skill nell'inventario"}; exit ${result.exitCode}).\n--- output ---\n${output}`,
  );
}

// ---------------------------------------------------------------------------
// Dispatch e tick
// ---------------------------------------------------------------------------

/** Riga del plugin del job, o `null` se sparita (cancellazione concorrente). */
async function loadPlugin(db: Db, pluginId: string): Promise<PluginRow | null> {
  const [row] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
  return row ?? null;
}

/** Esegue il job sul suo kind. Lancia in caso di fallimento (lo chiude il tick). */
async function dispatchPluginJob(deps: PluginPollerDeps, job: PluginJob): Promise<void> {
  const plugin = await loadPlugin(deps.db, job.pluginId);
  if (!plugin) throw new Error(`plugin ${job.pluginId} inesistente`);

  if (job.kind === "materialize") {
    await runMaterialize(deps, job, plugin);
    return;
  }
  if (job.kind === "smoke") {
    await runSmoke(deps, job, plugin);
    return;
  }
  // Difensivo: `kind` è vincolato a compile-time, ma una riga scritta da una
  // versione futura non deve bloccare la coda.
  throw new Error(`kind sconosciuto: ${String(job.kind)}`);
}

/**
 * Esegue UN giro: (0) recupero degli orfani `running` stantii, poi drena la coda
 * reclamando i job uno a uno. Ogni job in try/catch isolato. Ritorna il numero
 * di job conclusi con successo (utile ai test). Non lancia mai.
 */
export async function processPluginJobsOnce(deps: PluginPollerDeps): Promise<number> {
  try {
    await recoverStalePluginJobs(deps.db, PLUGIN_STALE_MINUTES, MAX_PLUGIN_ATTEMPTS);
  } catch (err) {
    deps.logger.error({ err }, "[plugins] recupero degli orfani 'running' fallito");
  }

  let done = 0;
  // Id già visti in QUESTO tick: ogni esito è terminale (done/failed), quindi un
  // job non può tornare claimabile nello stesso drain — se succedesse, questa
  // guardia evita di girare all'infinito sullo stesso id.
  const handled = new Set<string>();
  while (!deps.signal?.aborted) {
    let job: PluginJob | null;
    try {
      job = await claimNextPluginJob(deps.db);
    } catch (err) {
      // Errore DB transitorio: si interrompe il drain, si riprova al prossimo
      // tick. Nessun job è stato reclamato qui, quindi nulla da chiudere.
      deps.logger.error({ err }, "[plugins] claim del prossimo job fallito");
      break;
    }
    if (!job) break;
    const claimed = job;
    if (handled.has(claimed.id)) {
      deps.logger.warn(
        { jobId: claimed.id },
        "[plugins] job reclamato due volte nello stesso tick: interrompo il drain",
      );
      break;
    }
    handled.add(claimed.id);

    try {
      await dispatchPluginJob(deps, claimed);
      await completePluginJob(deps.db, claimed.id);
      done++;
    } catch (err) {
      deps.logger.error(
        { err, jobId: claimed.id, pluginId: claimed.pluginId, kind: claimed.kind },
        "[plugins] job del registro fallito",
      );
      try {
        await failPluginJob(deps.db, claimed.id, errText(err));
      } catch (txErr) {
        // Anche la chiusura è fallita (DB irraggiungibile?): il job resta
        // `running` e lo recupererà la fase orfani di un tick successivo.
        deps.logger.error({ err: txErr, jobId: claimed.id }, "[plugins] chiusura del job fallita");
      }
    }
  }
  return done;
}

export interface StartPluginPollerOptions extends PluginPollerDeps {
  /** Intervallo di poll in secondi. ≤ 0 = disabilitato (non avvia nulla). */
  intervalSeconds: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller su un proprio setInterval, separato dal loop dei job. Lo stop
 * avviene sull'AbortSignal del worker (passato anche a `processPluginJobsOnce`
 * per interrompere il drain a metà tick). Ritorna una funzione di stop
 * idempotente. intervalSeconds ≤ 0 = disabilitato: è il rollback della feature
 * (nessuna materializzazione parte, il registro resta com'è).
 */
export function startPluginPoller(opts: StartPluginPollerOptions): () => void {
  if (opts.intervalSeconds <= 0) {
    return () => {};
  }
  const { intervalSeconds, ...deps } = opts;
  let running = false;

  const tick = async (): Promise<void> => {
    // Evita sovrapposizioni se un giro è più lento dell'intervallo: un fetch
    // completo può durare minuti.
    if (running) return;
    running = true;
    try {
      await processPluginJobsOnce(deps);
    } catch (err) {
      // Difesa finale (processPluginJobsOnce già non lancia): mai propagare.
      deps.logger.error({ err }, "[plugins] tick fallito");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalSeconds * 1000);
  // Non tenere vivo il processo solo per il poller.
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
