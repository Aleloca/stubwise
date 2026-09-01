import { plugins, projectPlugins, type Db } from "@stubwise/db";
import { and, asc, eq } from "drizzle-orm";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basePluginPath } from "./base.js";
import { hookKey, normalizePluginName, parseFrontmatter, resolveSkillName } from "./inventory.js";

/**
 * COPIA FILTRATA per-run dei plugin abilitati su un progetto: è il punto in cui
 * il registro entra davvero nei run dell'agente.
 *
 * Perché una copia e non la dir del volume: gli spegnimenti sono per SKILL e
 * per GRUPPO DI HOOK, e il CLI non sa disabilitarli — `skillOverrides` è
 * cortocircuitato per le skill con source "plugin", quindi l'unico modo di
 * togliere una skill dal contesto è toglierla dal DISCO. La copia serve anche a
 * un invariante di sicurezza: il `.mcp.json` di un plugin NON viene copiato, così
 * i server MCP di un run passano solo da `--mcp-config` (`mcpConfig` del
 * runner). Cintura e bretelle: la copia toglie la skill dall'elenco, la deny
 * rule `Skill(<plugin>:<skill>)` ne blocca l'ESECUZIONE (vedi `disallowedTools`
 * in agent/runner.ts). Servono entrambe.
 *
 * DEGRADO SEMPRE FAIL-OPEN, MA MAI SILENZIOSO: ogni motivo per cui un plugin non
 * può essere preparato (dir sparita, manifest incoerente, copia fallita a metà)
 * lo salta per QUEL run e lascia proseguire il run, con una riga nel log
 * VISIBILE (il log del job per il fix, il logger per i job di backlog). Il
 * silenzio qui trasformerebbe una finestra TOCTOU nota — la dir dello sha
 * vecchio viene rimossa subito dopo l'UPDATE a `ready`, quindi un run che ha
 * letto la riga prima dell'aggiornamento può prendere `ENOENT` a metà copia — in
 * un bug non diagnosticabile.
 *
 * La copia vive nella dir temporanea del run (FUORI dalla cwd: nei run
 * multi-repo la cwd è la parent dir dei worktree, e qualunque cosa ci finisca
 * dentro l'agente la vede come file del progetto, fino a finire in un `git add`)
 * e sparisce col `cleanup()`. Costo: centinaia di KB.
 */

/**
 * Opzioni del runner che accendono i plugin per un run. Sono spread nelle
 * `runner.run({...})` come le altre "opt" della pipeline: quando sono vuote
 * l'argv del run resta IDENTICO a quello di prima dei plugin.
 */
export interface RunPluginOptions {
  pluginDirs?: string[];
  disallowedTools?: string[];
  /** Solo `""`: spegne ogni sorgente di settings del CLI. Vedi runner.ts. */
  settingSources?: "";
}

/** Esito della preparazione: le due liste da passare al runner. */
export interface PreparedRunPlugins {
  /** Dir da passare a `--plugin-dir`, NELL'ORDINE: base per primo, poi per slug. */
  pluginDirs: string[];
  /** Deny rule `Skill(<plugin>:<skill>)` delle skill spente dei plugin caricati. */
  disallowedTools: string[];
}

/** Riga di log del degrado: sempre await-ata in try/catch (un log non rompe un run). */
export type RunPluginLogFn = (message: string) => void | Promise<void>;

export interface PreparePluginsOptions {
  /** Progetto del run: decide QUALI plugin del registro d'istanza entrano. */
  projectId: string;
  /** Dir temporanea del run (esistente): ci nasce `plugins/<slug>`. */
  runTmpDir: string;
  /** Radice del volume dei plugin (`PLUGINS_DIR`). */
  pluginsDir: string;
  log: RunPluginLogFn;
  /** Iniettabile nei test: default `basePluginPath` (dir del plugin base). */
  basePluginPathFn?: () => string | null;
}

/**
 * Un solo segmento di path sicuro. Duplicato dal poller (dove è il guard del
 * PRODUTTORE) perché qui è il CONSUMATORE a concatenare `slug` e `resolvedSha`
 * a `PLUGINS_DIR` e a `runTmpDir`: le colonne non hanno CHECK, e uno slug come
 * `..` farebbe uscire dalle due directory una copia e una `rename`. Costa nulla
 * e la conseguenza di sbagliarsi è enorme (stessa logica di `assertNotOption`).
 */
function assertSafeSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} non utilizzabile come nome di directory: ${JSON.stringify(value)}`);
  }
}

/** `true` se il path è un FILE REGOLARE (`lstat`: i symlink non sono seguiti). */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** `true` se il path è una DIRECTORY reale (`lstat`: un symlink a dir non conta). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `name` di `.claude-plugin/plugin.json`, riletto dal disco. Null se il manifest
 * non c'è, non è un file regolare, non è JSON o non ha `name`: in tutti quei
 * casi la dir non è (più) un plugin e va saltata.
 */
async function readManifestName(pluginDir: string): Promise<string | null> {
  const path = join(pluginDir, ".claude-plugin", "plugin.json");
  if (!(await isRegularFile(path))) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) return null;
    // STESSA normalizzazione con cui l'inventario ha salvato il nome: il
    // confronto col registro deve poter combaciare.
    return normalizePluginName(parsed.name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Nomi delle DIRECTORY di skill da NON copiare, a partire dai nomi spenti.
 *
 * L'inventario registra la skill col `name` del frontmatter quando c'è
 * (`alpha-skill`), non col nome della directory (`alpha`), ed è quel nome che
 * un progetto salva in `disabled_skills`. Per tornare dalla skill spenta alla
 * dir da togliere si rilegge il frontmatter dal DISCO e si passa da
 * `resolveSkillName`, la STESSA funzione che ha prodotto il nome
 * nell'inventario: un solo punto di verità, così uno spegnimento salvato non
 * può smettere di applicarsi in silenzio. Si rilegge (invece di fidarsi
 * dell'inventario) perché la proprietà da preservare è «combacia con ciò che il
 * CLI risolverà a run-time sulla dir che gli passiamo», non «combacia con lo
 * snapshot al momento della materializzazione».
 */
async function resolveDisabledSkillDirs(
  pluginDir: string,
  disabled: Set<string>,
): Promise<Set<string>> {
  const dirs = new Set<string>();
  if (disabled.size === 0) return dirs;
  let entries: Dirent[];
  try {
    entries = await readdir(join(pluginDir, "skills"), { withFileTypes: true });
  } catch {
    // Nessuna dir `skills`: niente da escludere (le deny rule restano).
    return dirs;
  }
  for (const entry of entries) {
    // Solo directory reali: i symlink non sono seguiti (e non sono copiati).
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const file = join(pluginDir, "skills", entry.name, "SKILL.md");
    let frontmatter: Record<string, string> = {};
    if (await isRegularFile(file)) {
      try {
        frontmatter = parseFrontmatter(await readFile(file, "utf8"));
      } catch {
        // Illeggibile (permessi, lettura fallita a metà): frontmatter vuoto,
        // cioè "vale il nome della directory" — esattamente come fa
        // l'inventario nello stesso caso.
      }
    }
    if (disabled.has(resolveSkillName(entry.name, frontmatter))) dirs.add(entry.name);
  }
  return dirs;
}

/**
 * Contenuto di `hooks/hooks.json` da scrivere nella copia, o `null` per
 * OMETTERE il file (nessun gruppo acceso, o file non interpretabile mentre
 * qualcosa è spento: in dubbio non si esegue).
 */
async function buildFilteredHooks(
  pluginDir: string,
  disabled: Set<string>,
): Promise<{ content: string | null; reason?: string }> {
  const path = join(pluginDir, "hooks", "hooks.json");
  // Symlink/FIFO/directory al posto del file: trattato come assente.
  if (!(await isRegularFile(path))) return { content: null };

  let raw: string;
  let parsed: unknown;
  try {
    raw = await readFile(path, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    // Illeggibile o JSON rotto: se il progetto ha spento qualcosa non possiamo
    // garantire l'esclusione → si omette. Senza spegnimenti non c'è nulla da
    // filtrare, ma nemmeno nulla da salvare: un file che non si parsa non
    // definisce hook per il CLI, quindi si omette in ogni caso.
    return { content: null, reason: "hooks/hooks.json non leggibile o non JSON" };
  }
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
    return { content: null, reason: "hooks/hooks.json non ha la forma attesa" };
  }

  const events: Record<string, unknown> = {};
  let kept = 0;
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    // Valore non interpretabile (non un array di gruppi): l'inventario non lo
    // elenca, quindi non è spegnibile e non definisce hook. Si scarta.
    if (!Array.isArray(groups)) continue;
    // Il filtro è per POSIZIONE nell'array, la stessa che `hookKey` usa per
    // costruire la chiave salvata in `disabled_hooks`.
    const remaining = groups.filter((_, index) => !disabled.has(hookKey(event, index)));
    if (remaining.length === 0) continue;
    events[event] = remaining;
    kept += remaining.length;
  }
  if (kept === 0) return { content: null };
  return { content: `${JSON.stringify({ ...parsed, hooks: events }, null, 2)}\n` };
}

/** Esito della copia di un albero: quanti symlink sono stati ignorati. */
interface CopyStats {
  skippedLinks: number;
}

/**
 * Copia ricorsiva di `src` in `dest` senza MAI seguire i symlink (`readdir`
 * withFileTypes usa `lstat`) e saltando le voci per cui `skip` è vero.
 *
 * Il guard AUTOREVOLE sui symlink è il rifiuto dell'albero materializzato nel
 * poller; qui è difesa in profondità, e protegge dal caso "volume manipolato
 * fuori banda" (un link porterebbe nella copia — e quindi nel contesto
 * dell'agente — un file dell'host).
 */
async function copyTree(
  src: string,
  dest: string,
  skip: (relative: string, isDir: boolean) => boolean,
  stats: CopyStats,
  relative = "",
): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      stats.skippedLinks++;
      continue;
    }
    if (entry.isDirectory()) {
      if (skip(childRelative, true)) continue;
      await copyTree(join(src, entry.name), join(dest, entry.name), skip, stats, childRelative);
    } else if (entry.isFile()) {
      if (skip(childRelative, false)) continue;
      await copyFile(join(src, entry.name), join(dest, entry.name));
    }
    // Tutto il resto (FIFO, socket, device) non è copiato: non è materiale di
    // un plugin, e leggerlo potrebbe appendere il worker.
  }
}

/** Un plugin del registro abilitato sul progetto, come arriva dal DB. */
interface EnabledPlugin {
  slug: string;
  resolvedSha: string | null;
  /** `name` registrato all'ultima materializzazione (dall'inventario). */
  registryName: string | undefined;
  disabledSkills: string[];
  disabledHooks: string[];
}

/**
 * Prepara i plugin del progetto per UN run: copia filtrata sotto
 * `<runTmpDir>/plugins/<slug>` e deny rule delle skill spente.
 *
 * Non lancia mai per colpa di un singolo plugin: chi non è preparabile viene
 * saltato con una riga di log. Se nessun plugin del progetto entra, torna liste
 * VUOTE — base compreso: un run senza plugin del registro deve avere l'argv di
 * sempre, e il plugin base porta il contratto della run proprio ai run che i
 * plugin li caricano.
 */
export async function preparePluginsForRun(
  db: Db,
  options: PreparePluginsOptions,
): Promise<PreparedRunPlugins> {
  const rows = await db
    .select({
      slug: plugins.slug,
      resolvedSha: plugins.resolvedSha,
      inventory: plugins.inventory,
      disabledSkills: projectPlugins.disabledSkills,
      disabledHooks: projectPlugins.disabledHooks,
    })
    .from(projectPlugins)
    .innerJoin(plugins, eq(plugins.id, projectPlugins.pluginId))
    .where(
      and(
        eq(projectPlugins.projectId, options.projectId),
        eq(projectPlugins.enabled, true),
        eq(plugins.status, "ready"),
      ),
    )
    // Ordine STABILE e indipendente dall'ordine di abilitazione: i plugin del
    // progetto per slug (il base è prependato dopo).
    .orderBy(asc(plugins.slug));

  if (rows.length === 0) return { pluginDirs: [], disallowedTools: [] };

  const enabled: EnabledPlugin[] = rows.map((row) => ({
    slug: row.slug,
    resolvedSha: row.resolvedSha,
    registryName: row.inventory?.name,
    disabledSkills: row.disabledSkills,
    disabledHooks: row.disabledHooks,
  }));

  const pluginDirs: string[] = [];
  const disallowedTools: string[] = [];
  const destRoot = join(options.runTmpDir, "plugins");

  for (const plugin of enabled) {
    const skipped = async (reason: string): Promise<void> => {
      await logSafely(
        options.log,
        `[plugins] plugin '${plugin.slug}' saltato per questo run: ${reason}`,
      );
    };
    // Staging FUORI da `plugins/`: il CLI non deve mai vedere una copia a metà.
    // Solo una `rename` (atomica) la pubblica. Resta `null` finché lo slug non è
    // stato validato: il `finally` ci fa una `rm -rf` sopra, e costruire quel
    // path da uno slug non validato la porterebbe fuori dalla dir del run.
    let staging: string | null = null;
    try {
      if (!plugin.resolvedSha) {
        await skipped("nessuno sha risolto nel registro");
        continue;
      }
      assertSafeSegment(plugin.slug, "Lo slug del plugin");
      assertSafeSegment(plugin.resolvedSha, "Lo sha risolto del plugin");
      staging = join(options.runTmpDir, `.staging-${plugin.slug}`);
      const source = join(options.pluginsDir, plugin.slug, plugin.resolvedSha);
      if (!(await isDirectory(source))) {
        await skipped(
          `la directory materializzata ${plugin.slug}/${plugin.resolvedSha} non esiste (rimaterializza il plugin)`,
        );
        continue;
      }
      // Il manifest è riletto dal DISCO e confrontato col registro: una dir che
      // non è più quella descritta dal registro (aggiornamento in corso, volume
      // manomesso) non entra nel run — le deny rule sarebbero costruite su un
      // namespace sbagliato e non proteggerebbero nulla.
      const manifestName = await readManifestName(source);
      if (manifestName === null) {
        await skipped("manifest .claude-plugin/plugin.json assente o non valido");
        continue;
      }
      if (plugin.registryName !== undefined && manifestName !== plugin.registryName) {
        await skipped(
          `il manifest dichiara '${manifestName}' ma il registro ha '${plugin.registryName}'`,
        );
        continue;
      }

      const disabledSkills = new Set(plugin.disabledSkills);
      const disabledHooks = new Set(plugin.disabledHooks);
      const excludedSkillDirs = await resolveDisabledSkillDirs(source, disabledSkills);
      const hooks = await buildFilteredHooks(source, disabledHooks);

      const stats: CopyStats = { skippedLinks: 0 };
      await rm(staging, { recursive: true, force: true });
      await copyTree(
        source,
        staging,
        (relative, isDir) => {
          // `.mcp.json` MAI copiato: i server MCP di un run passano solo da
          // `--mcp-config` (invariante di sicurezza del design).
          if (!isDir && relative === ".mcp.json") return true;
          // Riscritto (o omesso) dopo la copia, mai copiato verbatim.
          if (!isDir && relative === "hooks/hooks.json") return true;
          if (isDir && relative.startsWith("skills/")) {
            return excludedSkillDirs.has(relative.slice("skills/".length));
          }
          return false;
        },
        stats,
      );
      if (hooks.content !== null) {
        await mkdir(join(staging, "hooks"), { recursive: true });
        await writeFile(join(staging, "hooks", "hooks.json"), hooks.content, "utf8");
      } else if (hooks.reason !== undefined) {
        await logSafely(
          options.log,
          `[plugins] plugin '${plugin.slug}': ${hooks.reason}, hook non caricati per questo run`,
        );
      }
      if (stats.skippedLinks > 0) {
        await logSafely(
          options.log,
          `[plugins] plugin '${plugin.slug}': ${stats.skippedLinks} symlink ignorati nella copia`,
        );
      }

      await mkdir(destRoot, { recursive: true });
      const dest = join(destRoot, plugin.slug);
      await rm(dest, { recursive: true, force: true });
      await rename(staging, dest);

      pluginDirs.push(dest);
      // Deny rule per OGNI skill spenta, anche se la sua dir non è stata
      // trovata: la copia toglie la skill dall'elenco, questa ne blocca
      // l'esecuzione, e sono due meccanismi indipendenti apposta.
      //
      // CASO RESIDUO NOTO, lasciato aperto di proposito: se il `SKILL.md` di una
      // skill spenta per nome-frontmatter fosse illeggibile PER NOI, la dir non
      // combacerebbe e verrebbe copiata; il CLI, se quel file lo leggesse,
      // risolverebbe il nome del frontmatter — che è proprio quello negato qui,
      // quindi resterebbe bloccata. Scoperto è solo il caso in cui NEMMENO il
      // CLI riesce a leggere il file: allora però non carica la skill affatto.
      // Chiuderlo (negare anche `Skill(<plugin>:<nome-dir>)` di ogni dir spenta)
      // aggiungerebbe deny rule che non esistono nell'inventario per proteggere
      // da una corruzione fuori banda del volume — le dir per sha sono
      // immutabili — e renderebbe meno leggibile la sola cosa che qui deve
      // essere ovvia: quali skill l'utente ha spento.
      for (const skill of new Set(plugin.disabledSkills)) {
        disallowedTools.push(`Skill(${manifestName}:${skill})`);
      }
    } catch (error) {
      // ENOENT a metà copia (finestra TOCTOU: la dir dello sha vecchio è stata
      // rimossa mentre copiavamo), permessi, disco pieno: il plugin salta, il
      // run prosegue. Lo staging incompleto non è mai stato visibile al CLI.
      await skipped(error instanceof Error ? error.message : String(error));
    } finally {
      if (staging !== null) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  // Nessun plugin del progetto preparato: nessun `--plugin-dir`, nessuna deny
  // rule, nessun `--setting-sources`. L'argv torna quello storico.
  if (pluginDirs.length === 0) return { pluginDirs: [], disallowedTools: [] };

  const base = (options.basePluginPathFn ?? basePluginPath)();
  if (base === null) {
    // Immagine buildata a metà (COPY dei plugin dimenticata): i run girano
    // senza il contratto della run del plugin base. È il degrado che
    // `basePluginPath` promette di rendere visibile.
    await logSafely(
      options.log,
      "[plugins] plugin base non trovato nell'immagine: il run gira senza il contratto della run",
    );
  }

  return {
    pluginDirs: base === null ? pluginDirs : [base, ...pluginDirs],
    disallowedTools,
  };
}

/** Log best-effort: un log rotto non deve mai far fallire un run. */
async function logSafely(log: RunPluginLogFn, message: string): Promise<void> {
  try {
    await log(message);
  } catch {
    // Ignorato di proposito.
  }
}

export interface OpenRunPluginsOptions {
  projectId: string;
  /** Radice del volume dei plugin. Assente = feature non configurata: nessun plugin. */
  pluginsDir?: string;
  log: RunPluginLogFn;
  basePluginPathFn?: () => string | null;
}

/** Plugin preparati per un run: le opzioni da spreadare e come liberare la copia. */
export interface OpenedRunPlugins {
  /**
   * Da spreadare in OGNI `runner.run` del run. Vuoto = argv storico:
   * `settingSources` c'è solo quando c'è almeno un `--plugin-dir`, perché
   * spegnere le sorgenti di settings a un run SENZA plugin ne cambierebbe il
   * comportamento senza motivo.
   */
  options: RunPluginOptions;
  /** Rimuove la dir temporanea del run. Idempotente, non lancia mai. */
  cleanup: () => Promise<void>;
}

/**
 * Apre i plugin per un run: crea la dir temporanea (in `os.tmpdir()`, FUORI da
 * qualunque cwd dell'agente, come il file di config MCP del runner), prepara le
 * copie filtrate e restituisce le opzioni già pronte da spreadare.
 *
 * NON LANCIA MAI: qualunque errore (DB irraggiungibile, tmp non scrivibile)
 * degrada a "nessun plugin" con una riga di log. Un run che oggi funziona non
 * deve poter fallire per il registro dei plugin.
 *
 * Il chiamante DEVE chiamare `cleanup()` in un `finally` che avvolge tutti i
 * `runner.run` del run.
 */
export async function openRunPlugins(
  db: Db,
  options: OpenRunPluginsOptions,
): Promise<OpenedRunPlugins> {
  const noop = { options: {}, cleanup: async (): Promise<void> => undefined };
  if (options.pluginsDir === undefined) return noop;

  let runTmpDir: string | undefined;
  try {
    runTmpDir = await mkdtemp(join(tmpdir(), "stubwise-plugins-"));
    const prepared = await preparePluginsForRun(db, {
      projectId: options.projectId,
      runTmpDir,
      pluginsDir: options.pluginsDir,
      log: options.log,
      ...(options.basePluginPathFn ? { basePluginPathFn: options.basePluginPathFn } : {}),
    });
    const dir = runTmpDir;
    const cleanup = async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    };
    if (prepared.pluginDirs.length === 0) {
      // Nessun plugin: la dir temporanea non serve più: si libera subito e si
      // torna l'opt VUOTA (argv storico).
      await cleanup();
      return noop;
    }
    return {
      options: {
        pluginDirs: prepared.pluginDirs,
        ...(prepared.disallowedTools.length > 0
          ? { disallowedTools: prepared.disallowedTools }
          : {}),
        settingSources: "",
      },
      cleanup,
    };
  } catch (error) {
    if (runTmpDir !== undefined) {
      await rm(runTmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await logSafely(
      options.log,
      `[plugins] preparazione dei plugin fallita, il run prosegue senza: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return noop;
  }
}
