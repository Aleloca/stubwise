import { pluginJobs, plugins, projectPlugins, projects, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { PluginInventory } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeAgentRunner } from "../agent/fake.js";
import type { AgentRunOptions } from "../agent/runner.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { fetchAtRef } from "./git.js";
import {
  MATERIALIZE_TIMEOUT_MS,
  processPluginJobsOnce,
  startPluginPoller,
  sweepOrphanPluginDirs,
  VALIDATE_TIMEOUT_MS,
  type PluginPollerDeps,
  type ValidatePluginFn,
} from "./poller.js";
import { PLUGIN_STALE_MINUTES } from "./queue.js";

/**
 * Test del poller del registro plugin su roba VERA: Postgres effimero
 * (testcontainers), filesystem vero, git vero su repo LOCALI creati qui.
 *
 * Le due sole iniezioni sono quelle che chiamerebbero il mondo esterno:
 *  - `validatePluginFn` (il CLI `claude plugin validate`), sostituito da una
 *    funzione che registra le chiamate e decide l'esito;
 *  - il runner dell'agente per lo smoke (`FakeAgentRunner`).
 * `fetchAtRefFn` è il fetch REALE, solo con l'allowlist allargata al trasporto
 * `file` (la produzione resta `https`: vedi git.ts).
 */

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await testDb.db.delete(plugins);
  await testDb.db.delete(projects);
  while (cleanups.length > 0) await cleanups.pop()?.();
});

afterAll(async () => {
  await testDb.stop();
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

const COMMIT_ARGS = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-plugin-poller-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Albero di un plugin valido, con due skill e un gruppo di hook. */
function pluginFiles(prefix = ""): Record<string, string> {
  const p = prefix === "" ? "" : `${prefix}/`;
  return {
    [`${p}.claude-plugin/plugin.json`]: JSON.stringify({ name: "demo", version: "1.0.0" }),
    [`${p}skills/alpha/SKILL.md`]: "---\nname: alpha\ndescription: prima\n---\n\ncorpo\n",
    [`${p}skills/beta/SKILL.md`]: "---\nname: beta\ndescription: seconda\n---\n\ncorpo\n",
    [`${p}hooks/hooks.json`]: JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo ciao" }] }] },
    }),
  };
}

/** Scrive i file (path relativi) dentro `dir`, creando le dir intermedie. */
async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

/** Repo git locale con un commit che contiene `files`. Ritorna dir e sha. */
async function makeSource(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<{ dir: string; sha: string }> {
  const dir = join(root, name);
  await execa("git", ["init", "-q", "-b", "main", dir]);
  await writeTree(dir, files);
  await execa("git", [...COMMIT_ARGS, "add", "-A"], { cwd: dir });
  await execa("git", [...COMMIT_ARGS, "commit", "-q", "-m", "plugin"], { cwd: dir });
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: dir });
  return { dir, sha: stdout.trim() };
}

/** Commit aggiuntivo su un repo sorgente già creato. */
async function commitMore(dir: string, files: Record<string, string>): Promise<string> {
  await writeTree(dir, files);
  await execa("git", [...COMMIT_ARGS, "add", "-A"], { cwd: dir });
  await execa("git", [...COMMIT_ARGS, "commit", "-q", "-m", "update"], { cwd: dir });
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

let counter = 0;

async function insertPlugin(
  db: Db,
  overrides: Partial<typeof plugins.$inferInsert> = {},
): Promise<{ id: string; slug: string }> {
  counter++;
  const slug = overrides.slug ?? `demo-${counter}`;
  const [row] = await db
    .insert(plugins)
    .values({
      slug,
      name: "demo",
      sourceUrl: "https://example.com/org/demo.git",
      ref: "main",
      ...overrides,
    })
    .returning({ id: plugins.id });
  return { id: row!.id, slug };
}

async function enqueue(
  db: Db,
  pluginId: string,
  kind: "materialize" | "smoke" = "materialize",
  createdAt?: Date,
): Promise<string> {
  const [job] = await db
    .insert(pluginJobs)
    .values({ pluginId, kind, ...(createdAt ? { createdAt } : {}) })
    .returning({ id: pluginJobs.id });
  return job!.id;
}

/** Progetto minimo (la colonna `ingestion_key` è NOT NULL senza default utile). */
async function insertProject(db: Db, slug: string): Promise<string> {
  counter++;
  const [project] = await db
    .insert(projects)
    .values({ name: slug, slug: `${slug}-${counter}`, ingestionKey: `k-${counter}` })
    .returning({ id: projects.id });
  return project!.id;
}

async function readPlugin(db: Db, id: string) {
  const [row] = await db.select().from(plugins).where(eq(plugins.id, id));
  return row!;
}

async function readJobs(db: Db, pluginId: string) {
  return db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
}

/** Fetch reale, col solo trasporto `file` abilitato (repo locali dei test). */
const localFetch: typeof fetchAtRef = (url, ref, destDir, options) =>
  fetchAtRef(url, ref, destDir, { ...options, allowedProtocols: ["file"] });

const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };

interface MakeDepsOptions {
  pluginsDir: string;
  validate?: ValidatePluginFn;
  runner?: FakeAgentRunner;
  basePluginPathFn?: () => string | null;
  /** Catena dei provider AI risolta. Default: vuota (auth di default). */
  chain?: ResolvedProvider[];
}

function makeDeps(options: MakeDepsOptions): PluginPollerDeps {
  return {
    db: testDb.db,
    pluginsDir: options.pluginsDir,
    encryptionKey: Buffer.alloc(32),
    logger: silentLogger,
    fetchAtRefFn: localFetch,
    validatePluginFn: options.validate ?? (async () => ({ ok: true, output: "" })),
    // SEMPRE un runner finto, anche nei test della sola materializzazione: il
    // drain di un tick consuma pure lo smoke appena accodato, e il default del
    // poller è il CLI vero.
    runner: options.runner ?? new FakeAgentRunner(),
    basePluginPathFn: options.basePluginPathFn ?? (() => null),
    // Catena vuota di default: lo smoke gira con l'auth di default del
    // container (comportamento del self-hosting senza catena).
    loadProviderChainFn: async () => options.chain ?? [],
  };
}

// ---------------------------------------------------------------------------
// Invariante di staleness
// ---------------------------------------------------------------------------

describe("invariante di staleness del registro", () => {
  it("la soglia degli orfani supera il budget massimo di una materializzazione", () => {
    // È ciò che rende sicuro riusare `.tmp-<jobId>` per lo stesso job: finché
    // un materializzatore vivo non può superare la soglia, il recovery non
    // riaccoda MAI un job che sta ancora girando (e l'indice unico, che copre
    // solo i job diversi, non potrebbe farci nulla). Il margine di 3' copre il
    // lavoro di filesystem senza budget proprio (rimozione di `.git`, lettura
    // dell'inventario, rename della dir pubblicata).
    const budget = MATERIALIZE_TIMEOUT_MS + VALIDATE_TIMEOUT_MS + 3 * 60_000;
    expect(PLUGIN_STALE_MINUTES * 60_000).toBeGreaterThan(budget);
  });
});

// ---------------------------------------------------------------------------
// materialize
// ---------------------------------------------------------------------------

describe("processPluginJobsOnce — materialize", () => {
  it("materializza, valida, costruisce l'inventario e accoda lo smoke", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const source = await makeSource(root, "source", pluginFiles());
    const pluginsDir = join(root, "plugins");
    const { id, slug } = await insertPlugin(db, { sourceUrl: source.dir });
    const jobId = await enqueue(db, id);

    // Il drain si ferma DOPO la materializzazione: lo smoke che essa accoda
    // resta in coda, così si può osservare lo stato subito dopo il `ready`
    // (ed è anche la verifica dello stop cooperativo sull'AbortSignal).
    const controller = new AbortController();
    const validated: string[] = [];
    const done = await processPluginJobsOnce({
      ...makeDeps({
        pluginsDir,
        validate: async (dir) => {
          validated.push(dir);
          controller.abort();
          return { ok: true, output: "" };
        },
      }),
      signal: controller.signal,
    });

    expect(done).toBe(1);

    const plugin = await readPlugin(db, id);
    expect(plugin.status).toBe("ready");
    expect(plugin.resolvedSha).toBe(source.sha);
    expect(plugin.error).toBeNull();
    expect(plugin.materializedAt).not.toBeNull();
    const inventory = plugin.inventory as PluginInventory;
    expect(inventory.name).toBe("demo");
    expect(inventory.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(inventory.hooks.map((h) => h.key)).toEqual(["SessionStart#0"]);

    // La dir pubblicata è `<slug>/<sha>` ed È la dir del plugin.
    const pluginDir = join(pluginsDir, slug, source.sha);
    expect(existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
    // Niente `.git` (lo toglie fetchAtRef) e niente dir temporanee residue.
    expect(existsSync(join(pluginDir, ".git"))).toBe(false);
    expect(await readdir(join(pluginsDir, slug))).toEqual([source.sha]);
    // Il validate gira UNA volta, sulla dir TEMPORANEA: un plugin bocciato non
    // compare mai su `<slug>/<sha>` (vedi il test del validate fallito).
    expect(validated).toHaveLength(1);
    expect(validated[0]?.startsWith(join(pluginsDir, slug))).toBe(true);
    expect(validated[0]).not.toBe(pluginDir);

    const jobs = await readJobs(db, id);
    expect(jobs.find((j) => j.id === jobId)?.status).toBe("done");
    const smoke = jobs.find((j) => j.kind === "smoke");
    expect(smoke?.status).toBe("queued");
    expect(plugin.smokeStatus).toBe("pending");
  });

  it("con sourceSubdir pubblica la SOTTOCARTELLA come dir del plugin", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const source = await makeSource(root, "source", {
      ...pluginFiles("packages/demo"),
      "README.md": "monorepo",
    });
    const pluginsDir = join(root, "plugins");
    const { id, slug } = await insertPlugin(db, {
      sourceUrl: source.dir,
      sourceSubdir: "packages/demo",
    });
    await enqueue(db, id);

    await processPluginJobsOnce(makeDeps({ pluginsDir }));

    const plugin = await readPlugin(db, id);
    expect(plugin.status).toBe("ready");
    const pluginDir = join(pluginsDir, slug, source.sha);
    expect(existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
    // Il resto del monorepo NON finisce sul volume.
    expect(existsSync(join(pluginDir, "README.md"))).toBe(false);
    expect(existsSync(join(pluginDir, "packages"))).toBe(false);
  });

  it("fallisce senza pubblicare nulla se il validate boccia il plugin", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const source = await makeSource(root, "source", pluginFiles());
    const pluginsDir = join(root, "plugins");
    const { id, slug } = await insertPlugin(db, { sourceUrl: source.dir });

    await enqueue(db, id);
    const done = await processPluginJobsOnce(
      makeDeps({
        pluginsDir,
        validate: async () => ({ ok: false, output: "manifest non valido: campo x" }),
      }),
    );

    expect(done).toBe(0);
    const plugin = await readPlugin(db, id);
    expect(plugin.status).toBe("failed");
    expect(plugin.error).toContain("manifest non valido");
    expect(plugin.resolvedSha).toBeNull();
    expect(plugin.inventory).toBeNull();
    expect(existsSync(join(pluginsDir, slug, source.sha))).toBe(false);

    const jobs = await readJobs(db, id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("failed");
  });

  it("fallisce con errore redatto se il fetch non trova il ref", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const source = await makeSource(root, "source", pluginFiles());
    const pluginsDir = join(root, "plugins");
    const { id, slug } = await insertPlugin(db, {
      sourceUrl: source.dir,
      ref: "v-non-esiste",
    });
    await enqueue(db, id);

    await processPluginJobsOnce(makeDeps({ pluginsDir }));

    const plugin = await readPlugin(db, id);
    expect(plugin.status).toBe("failed");
    expect(plugin.error).toBeTruthy();
    expect(plugin.status).not.toBe("ready");
    // Nessuna checkout parziale lasciata in giro sotto lo slug.
    const slugDir = join(pluginsDir, slug);
    if (existsSync(slugDir)) expect(await readdir(slugDir)).toEqual([]);
  });

  it("rifiuta un albero che contiene symlink, anche dentro sourceSubdir", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const dir = join(root, "source");
    await execa("git", ["init", "-q", "-b", "main", dir]);
    await writeTree(dir, pluginFiles("packages/demo"));
    // Symlink che ESCE dalla dir del plugin: è esattamente ciò che il guard
    // deve impedire (il CLI lo seguirebbe dentro il run).
    await symlink("/etc/passwd", join(dir, "packages", "demo", "skills", "leak.md"));
    await execa("git", [...COMMIT_ARGS, "add", "-A"], { cwd: dir });
    await execa("git", [...COMMIT_ARGS, "commit", "-q", "-m", "link"], { cwd: dir });
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: dir });
    const sha = stdout.trim();

    const pluginsDir = join(root, "plugins");
    const { id, slug } = await insertPlugin(db, {
      sourceUrl: dir,
      sourceSubdir: "packages/demo",
    });
    await enqueue(db, id);

    let validateCalled = false;
    await processPluginJobsOnce(
      makeDeps({
        pluginsDir,
        validate: async () => {
          validateCalled = true;
          return { ok: true, output: "" };
        },
      }),
    );

    const plugin = await readPlugin(db, id);
    expect(plugin.status).toBe("failed");
    expect(plugin.error).toContain("symlink");
    expect(plugin.error).toContain("skills/leak.md");
    // Il guard scatta PRIMA del validate e prima di pubblicare la dir.
    expect(validateCalled).toBe(false);
    expect(existsSync(join(pluginsDir, slug, sha))).toBe(false);
  });

  it("rifiuta uno slug o una subdir che uscirebbero dal volume", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const source = await makeSource(root, "source", pluginFiles());
    const pluginsDir = join(root, "plugins");

    // Lo slug lo deriva il server e la colonna non ha CHECK: qui è l'ultimo
    // punto prima di `rm`/`rename` su un path costruito da quella stringa.
    const evil = await insertPlugin(db, { slug: "../fuori", sourceUrl: source.dir });
    await enqueue(db, evil.id);
    const traversal = await insertPlugin(db, {
      sourceUrl: source.dir,
      sourceSubdir: "packages/../../fuori",
    });
    await enqueue(db, traversal.id);

    await processPluginJobsOnce(makeDeps({ pluginsDir }));

    expect((await readPlugin(db, evil.id)).status).toBe("failed");
    expect((await readPlugin(db, evil.id)).error).toContain("slug");
    expect((await readPlugin(db, traversal.id)).status).toBe("failed");
    expect((await readPlugin(db, traversal.id)).error).toContain("Sottocartella");
    expect(existsSync(join(root, "fuori"))).toBe(false);
  });

  it("all'aggiornamento rimuove le dir degli sha vecchi e pota gli spegnimenti obsoleti", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const source = await makeSource(root, "source", pluginFiles());
    const pluginsDir = join(root, "plugins");

    const { id, slug } = await insertPlugin(db, { sourceUrl: source.dir });
    await enqueue(db, id);
    await processPluginJobsOnce(makeDeps({ pluginsDir }));
    const oldSha = (await readPlugin(db, id)).resolvedSha;
    expect(oldSha).toBe(source.sha);

    // Un progetto ha spento una skill e un hook che l'aggiornamento farà sparire.
    const projectId = await insertProject(db, "con-voci-obsolete");
    const stale = new Date(Date.now() - 3_600_000);
    await db.insert(projectPlugins).values({
      projectId,
      pluginId: id,
      disabledSkills: ["alpha", "beta"],
      disabledHooks: ["SessionStart#0", "Stop#2"],
      updatedAt: stale,
    });

    // Un secondo progetto ha spento SOLO voci che sopravvivono: la sua riga non
    // deve essere riscritta affatto (l'UPDATE è mirato, non un salvataggio
    // cieco della lista che il poller ha letto).
    const untouchedProjectId = await insertProject(db, "gia-pulito");
    await db.insert(projectPlugins).values({
      projectId: untouchedProjectId,
      pluginId: id,
      disabledSkills: ["alpha"],
      disabledHooks: [],
      updatedAt: stale,
    });

    // Dir temporanea orfana di un worker morto a metà: la potatura del `ready`
    // successivo è ciò che la rimuove.
    await mkdir(join(pluginsDir, slug, ".tmp-orfana"), { recursive: true });

    // Nuova versione: `beta` sparisce, gli hook spariscono del tutto.
    await rm(join(source.dir, "skills", "beta"), { recursive: true });
    await rm(join(source.dir, "hooks"), { recursive: true });
    const newSha = await commitMore(source.dir, {
      "skills/gamma/SKILL.md": "---\nname: gamma\n---\n\nnuova\n",
    });
    expect(newSha).not.toBe(oldSha);

    await db.delete(pluginJobs).where(eq(pluginJobs.pluginId, id));
    await enqueue(db, id);
    await processPluginJobsOnce(makeDeps({ pluginsDir }));

    const plugin = await readPlugin(db, id);
    expect(plugin.status).toBe("ready");
    expect(plugin.resolvedSha).toBe(newSha);
    // Sul volume resta SOLO lo sha corrente: sha vecchio e `.tmp-*` orfana via.
    expect(await readdir(join(pluginsDir, slug))).toEqual([newSha]);

    const [pruned] = await db
      .select()
      .from(projectPlugins)
      .where(
        and(eq(projectPlugins.pluginId, id), eq(projectPlugins.projectId, projectId)),
      );
    expect(pruned?.disabledSkills).toEqual(["alpha"]);
    expect(pruned?.disabledHooks).toEqual([]);
    expect(pruned!.updatedAt.getTime()).toBeGreaterThan(stale.getTime());

    const [untouched] = await db
      .select()
      .from(projectPlugins)
      .where(
        and(eq(projectPlugins.pluginId, id), eq(projectPlugins.projectId, untouchedProjectId)),
      );
    expect(untouched?.disabledSkills).toEqual(["alpha"]);
    expect(untouched!.updatedAt.getTime()).toBe(stale.getTime());
  });

  it("ri-materializzando lo stesso sha non lascia mai il path senza una dir valida", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const source = await makeSource(root, "source", pluginFiles());
    const pluginsDir = join(root, "plugins");
    const { id, slug } = await insertPlugin(db, { sourceUrl: source.dir });

    await enqueue(db, id);
    await processPluginJobsOnce(makeDeps({ pluginsDir }));
    await db.delete(pluginJobs).where(eq(pluginJobs.pluginId, id));
    await enqueue(db, id);
    await processPluginJobsOnce(makeDeps({ pluginsDir }));

    const plugin = await readPlugin(db, id);
    expect(plugin.status).toBe("ready");
    expect(plugin.resolvedSha).toBe(source.sha);
    // Nessuna `<sha>.old` residua: la dir pubblicata è una sola ed è completa.
    expect(await readdir(join(pluginsDir, slug))).toEqual([source.sha]);
    expect(
      existsSync(join(pluginsDir, slug, source.sha, ".claude-plugin", "plugin.json")),
    ).toBe(true);
  });

  it("non lascia uno smoke `pending` orfano se ce n'è già uno attivo", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const source = await makeSource(root, "source", pluginFiles());
    const pluginsDir = join(root, "plugins");
    const { id } = await insertPlugin(db, { sourceUrl: source.dir });

    // Uno smoke è già in coda (materializzazione precedente, o click "Riprova").
    // La materialize è più vecchia, quindi il claim FIFO la prende per prima.
    await enqueue(db, id, "smoke");
    await enqueue(db, id, "materialize", new Date(Date.now() - 60_000));

    // Stop dopo la sola materializzazione, come nel test felice.
    const controller = new AbortController();
    await processPluginJobsOnce({
      ...makeDeps({
        pluginsDir,
        validate: async () => {
          controller.abort();
          return { ok: true, output: "" };
        },
      }),
      signal: controller.signal,
    });

    const jobs = await readJobs(db, id);
    expect(jobs.filter((j) => j.kind === "smoke")).toHaveLength(1);
    // `onConflictDoNothing`: nessun job nuovo, quindi nemmeno un `pending` che
    // resterebbe senza chi lo risolve.
    expect((await readPlugin(db, id)).smokeStatus).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// smoke
// ---------------------------------------------------------------------------

/** Plugin già materializzato sul volume, pronto per uno smoke. */
async function seedReadyPlugin(
  db: Db,
  pluginsDir: string,
): Promise<{ id: string; slug: string; sha: string; pluginDir: string }> {
  const sha = "c".repeat(40);
  const inventory: PluginInventory = {
    name: "demo",
    skills: [
      { name: "alpha", bytes: 10 },
      { name: "beta", bytes: 12 },
    ],
    commands: [],
    agents: [],
    hooks: [],
    hasMcp: false,
  };
  const { id, slug } = await insertPlugin(db, {
    status: "ready",
    resolvedSha: sha,
    inventory,
    smokeStatus: "pending",
    materializedAt: new Date(),
  });
  const pluginDir = join(pluginsDir, slug, sha);
  await writeTree(pluginDir, pluginFiles());
  return { id, slug, sha, pluginDir };
}

describe("processPluginJobsOnce — smoke", () => {
  it("passa quando l'agente elenca tutte le skill col namespace del plugin", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    const { id, pluginDir } = await seedReadyPlugin(db, pluginsDir);
    await enqueue(db, id, "smoke");

    const base = join(root, "base");
    await mkdir(base, { recursive: true });
    const runner = new FakeAgentRunner({ output: "demo:alpha\ndemo:beta\naltro:cosa" });

    const done = await processPluginJobsOnce(
      makeDeps({ pluginsDir, runner, basePluginPathFn: () => base }),
    );

    expect(done).toBe(1);
    const plugin = await readPlugin(db, id);
    expect(plugin.smokeStatus).toBe("passed");
    expect(plugin.smokeError).toBeNull();
    expect(plugin.status).toBe("ready");

    const call = runner.calls[0] as AgentRunOptions;
    expect(call.model).toBe("haiku");
    expect(call.maxTurns).toBe(1);
    expect(call.settingSources).toBe("");
    // Plugin base per PRIMO, poi il plugin sotto esame (integrale, non filtrato).
    expect(call.pluginDirs).toEqual([base, pluginDir]);
  });

  it("fallisce elencando le skill mancanti quando l'agente non le vede", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    const { id } = await seedReadyPlugin(db, pluginsDir);
    await enqueue(db, id, "smoke");

    const runner = new FakeAgentRunner({ output: "demo:alpha" });
    const done = await processPluginJobsOnce(makeDeps({ pluginsDir, runner }));

    expect(done).toBe(0);
    const plugin = await readPlugin(db, id);
    expect(plugin.smokeStatus).toBe("failed");
    expect(plugin.smokeError).toContain("demo:beta");
    expect(plugin.smokeError).toContain("demo:alpha");
    // Lo stato del plugin resta `ready`: a fallire è lo smoke, non la materializzazione.
    expect(plugin.status).toBe("ready");
  });

  it("tollera la formattazione dell'elenco (spazi e a capo attorno ai due punti)", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    const { id } = await seedReadyPlugin(db, pluginsDir);
    await enqueue(db, id, "smoke");

    // Un badge rosso su un plugin funzionante sarebbe peggio di un badge verde
    // permissivo: qui il modello ha solo impaginato l'elenco a modo suo.
    const runner = new FakeAgentRunner({
      output: "- Demo: alpha\n- demo :\n  beta\n",
    });
    await processPluginJobsOnce(makeDeps({ pluginsDir, runner }));

    expect((await readPlugin(db, id)).smokeStatus).toBe("passed");
  });

  it("non lascia il segreto del provider dentro smoke_error", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    const { id } = await seedReadyPlugin(db, pluginsDir);
    await enqueue(db, id, "smoke");

    const secret = "sk-ant-segretissimo-123";
    const chain: ResolvedProvider[] = [{ id: "p1", kind: "api_key", secret }];
    const runner = new FakeAgentRunner({
      output: `errore di auth con la chiave ${secret}`,
      exitCode: 1,
    });

    await processPluginJobsOnce(makeDeps({ pluginsDir, runner, chain }));

    // Il provider è quello della catena globale...
    expect((runner.calls[0] as AgentRunOptions).provider?.secret).toBe(secret);
    // ...ma non deve arrivare nel DB (e quindi in UI) nemmeno se il CLI lo stampa.
    const plugin = await readPlugin(db, id);
    expect(plugin.smokeStatus).toBe("failed");
    expect(plugin.smokeError).not.toContain(secret);
    expect(plugin.smokeError).toContain("***");
  });

  it("fallisce su exit code non-zero anche se l'output elenca le skill", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    const { id } = await seedReadyPlugin(db, pluginsDir);
    await enqueue(db, id, "smoke");

    const runner = new FakeAgentRunner({ output: "demo:alpha demo:beta", exitCode: 1 });
    await processPluginJobsOnce(makeDeps({ pluginsDir, runner }));

    expect((await readPlugin(db, id)).smokeStatus).toBe("failed");
  });

  it("gira senza plugin base se l'immagine non lo espone", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    const { id, pluginDir } = await seedReadyPlugin(db, pluginsDir);
    await enqueue(db, id, "smoke");

    const runner = new FakeAgentRunner({ output: "demo:alpha demo:beta" });
    await processPluginJobsOnce(
      makeDeps({ pluginsDir, runner, basePluginPathFn: () => null }),
    );

    expect((await readPlugin(db, id)).smokeStatus).toBe("passed");
    expect((runner.calls[0] as AgentRunOptions).pluginDirs).toEqual([pluginDir]);
  });

  it("fallisce se la dir materializzata non esiste più", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    const { id, pluginDir } = await seedReadyPlugin(db, pluginsDir);
    await rm(pluginDir, { recursive: true, force: true });
    await enqueue(db, id, "smoke");

    const runner = new FakeAgentRunner();
    await processPluginJobsOnce(makeDeps({ pluginsDir, runner }));

    const plugin = await readPlugin(db, id);
    expect(plugin.smokeStatus).toBe("failed");
    expect(runner.calls).toHaveLength(0);
  });
});

describe("startPluginPoller", () => {
  it("con intervallo 0 non avvia nulla", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    const { id } = await seedReadyPlugin(db, pluginsDir);
    await enqueue(db, id, "smoke");

    const controller = new AbortController();
    const stop = startPluginPoller({
      ...makeDeps({ pluginsDir, runner: new FakeAgentRunner() }),
      intervalSeconds: 0,
      signal: controller.signal,
    });
    stop();
    controller.abort();

    // Nessun tick: il job resta in coda.
    const jobs = await readJobs(db, id);
    expect(jobs[0]?.status).toBe("queued");
  });
});

// ---------------------------------------------------------------------------
// Sweep delle dir di slug orfane
// ---------------------------------------------------------------------------

describe("sweepOrphanPluginDirs", () => {
  it("rimuove solo le dir di slug che non hanno più una riga in `plugins`", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    const { slug: vivo } = await insertPlugin(db, { slug: "vivo" });

    // Due dir sul volume: una del plugin vivo, una di un plugin cancellato
    // (nessuna riga la reclama più).
    await mkdir(join(pluginsDir, vivo, "a".repeat(40)), { recursive: true });
    await mkdir(join(pluginsDir, "cancellato", "b".repeat(40)), { recursive: true });
    await writeFile(join(pluginsDir, "cancellato", "b".repeat(40), "f.txt"), "x", "utf8");

    const removed = await sweepOrphanPluginDirs(makeDeps({ pluginsDir }));
    expect(removed).toEqual(["cancellato"]);
    expect(existsSync(join(pluginsDir, vivo))).toBe(true);
    expect(existsSync(join(pluginsDir, "cancellato"))).toBe(false);
  });

  it("non tocca nulla quando ogni dir ha la sua riga", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    const { slug: a } = await insertPlugin(db, { slug: "alfa" });
    const { slug: b } = await insertPlugin(db, { slug: "beta" });
    await mkdir(join(pluginsDir, a), { recursive: true });
    await mkdir(join(pluginsDir, b), { recursive: true });

    expect(await sweepOrphanPluginDirs(makeDeps({ pluginsDir }))).toEqual([]);
    expect(existsSync(join(pluginsDir, a))).toBe(true);
    expect(existsSync(join(pluginsDir, b))).toBe(true);
  });

  it("non costa niente (nessuna query) su un volume vuoto o inesistente", async () => {
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    // Una riga c'è: se lo sweep interrogasse comunque il DB, non se ne
    // accorgerebbe nessuno — perciò si conta la query.
    await insertPlugin(testDb.db, { slug: "vivo" });

    const deps = makeDeps({ pluginsDir });
    let queries = 0;
    const counting = {
      ...deps,
      db: new Proxy(deps.db, {
        get(target, prop, receiver) {
          if (prop === "select") queries++;
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }) as Db,
    };

    // Volume inesistente.
    expect(await sweepOrphanPluginDirs(counting)).toEqual([]);
    // Volume esistente ma vuoto.
    await mkdir(pluginsDir, { recursive: true });
    expect(await sweepOrphanPluginDirs(counting)).toEqual([]);
    expect(queries).toBe(0);
  });

  it("ignora ciò che non è una directory (file e symlink di primo livello)", async () => {
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    await mkdir(join(pluginsDir, "orfana"), { recursive: true });
    await writeFile(join(pluginsDir, "un-file"), "x", "utf8");
    await symlink(root, join(pluginsDir, "un-link"));

    const removed = await sweepOrphanPluginDirs(makeDeps({ pluginsDir }));
    expect(removed).toEqual(["orfana"]);
    // Il link NON viene seguito né rimosso: non lo crea questo modulo, e
    // rimuoverlo non è compito di uno sweep di slug.
    expect(existsSync(join(pluginsDir, "un-link"))).toBe(true);
    expect(existsSync(join(pluginsDir, "un-file"))).toBe(true);
    expect(existsSync(root)).toBe(true);
  });
});
