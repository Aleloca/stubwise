import { plugins, projectPlugins, projects, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { PluginInventory } from "@stubwise/shared";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openRunPlugins, preparePluginsForRun } from "./materialize-run.js";

/**
 * Test della COPIA FILTRATA per-run su roba vera: Postgres effimero
 * (testcontainers) e filesystem vero. Nessuna iniezione tranne
 * `basePluginPathFn` (il plugin base sta nell'immagine del worker, non nel
 * volume dei test) e il `log`, raccolto in un array per asserire che ogni
 * degrado sia VISIBILE.
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

let counter = 0;

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stubwise-plugin-run-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

/** Albero di un plugin materializzato: due skill, un comando, due gruppi di hook, un `.mcp.json`. */
function pluginFiles(name = "demo"): Record<string, string> {
  return {
    ".claude-plugin/plugin.json": JSON.stringify({ name, version: "1.0.0" }),
    // `name` del frontmatter DIVERSO dalla directory: è il nome
    // dell'inventario (e della deny rule) a comandare, non la dir.
    "skills/alpha/SKILL.md": "---\nname: alpha-skill\ndescription: prima\n---\n\ncorpo alpha\n",
    "skills/alpha/rif.md": "riferimento della skill alpha\n",
    "skills/beta/SKILL.md": "---\nname: beta-skill\ndescription: seconda\n---\n\ncorpo beta\n",
    "commands/fai.md": "# comando\n",
    "hooks/session-start.sh": "#!/bin/sh\necho ciao\n",
    "hooks/hooks.json": JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "echo uno" }] },
          { matcher: "resume", hooks: [{ type: "command", command: "echo due" }] },
        ],
      },
    }),
    ".mcp.json": JSON.stringify({ mcpServers: { esempio: { command: "node" } } }),
  };
}

/** Inventario coerente con {@link pluginFiles}. */
function inventoryOf(name = "demo"): PluginInventory {
  return {
    name,
    version: "1.0.0",
    skills: [
      { name: "alpha-skill", description: "prima", bytes: 10 },
      { name: "beta-skill", description: "seconda", bytes: 10 },
    ],
    commands: [{ name: "fai" }],
    agents: [],
    hooks: [
      { key: "SessionStart#0", event: "SessionStart", matcher: "startup", command: "echo uno" },
      { key: "SessionStart#1", event: "SessionStart", matcher: "resume", command: "echo due" },
    ],
    hasMcp: true,
  };
}

/** Sha fittizio ma della forma giusta (segmento di path sicuro). */
function fakeSha(seed: number): string {
  return `${seed}`.padStart(40, "a");
}

interface Materialized {
  id: string;
  slug: string;
  sha: string;
  /** Dir del plugin sul volume: `<pluginsDir>/<slug>/<sha>`. */
  dir: string;
}

/** Registra un plugin `ready` E ne materializza la dir sul volume. */
async function materializePlugin(
  db: Db,
  pluginsDir: string,
  options: {
    name?: string;
    files?: Record<string, string>;
    inventory?: PluginInventory;
    status?: "none" | "materializing" | "ready" | "failed";
    /** `false` = riga a DB senza dir sul volume (finestra TOCTOU). */
    onDisk?: boolean;
  } = {},
): Promise<Materialized> {
  counter++;
  const slug = `demo-${counter}`;
  const sha = fakeSha(counter);
  const name = options.name ?? "demo";
  const [row] = await db
    .insert(plugins)
    .values({
      slug,
      name,
      sourceUrl: "https://example.com/org/demo.git",
      ref: "main",
      resolvedSha: sha,
      status: options.status ?? "ready",
      inventory: options.inventory ?? inventoryOf(name),
      materializedAt: new Date(),
    })
    .returning({ id: plugins.id });
  const dir = join(pluginsDir, slug, sha);
  if (options.onDisk !== false) await writeTree(dir, options.files ?? pluginFiles(name));
  return { id: row!.id, slug, sha, dir };
}

async function insertProject(db: Db): Promise<string> {
  counter++;
  const [project] = await db
    .insert(projects)
    .values({ name: `p${counter}`, slug: `p-run-${counter}`, ingestionKey: `k-run-${counter}` })
    .returning({ id: projects.id });
  return project!.id;
}

async function enable(
  db: Db,
  projectId: string,
  pluginId: string,
  overrides: { enabled?: boolean; disabledSkills?: string[]; disabledHooks?: string[] } = {},
): Promise<void> {
  await db.insert(projectPlugins).values({ projectId, pluginId, ...overrides });
}

/** Directory (finta) del plugin base: qui basta che esista un path. */
async function makeBase(root: string): Promise<string> {
  const dir = join(root, "base", "stubwise-base");
  await writeTree(dir, { ".claude-plugin/plugin.json": JSON.stringify({ name: "stubwise-base" }) });
  return dir;
}

interface PrepareCase {
  logs: string[];
  runTmpDir: string;
  pluginsDir: string;
}

async function makeCase(root: string): Promise<PrepareCase> {
  const runTmpDir = join(root, "run");
  await mkdir(runTmpDir, { recursive: true });
  return { logs: [], runTmpDir, pluginsDir: join(root, "plugins") };
}

// ---------------------------------------------------------------------------
// preparePluginsForRun
// ---------------------------------------------------------------------------

describe("preparePluginsForRun", () => {
  it("copia il plugin senza le skill spente, senza i gruppi di hook spenti e senza .mcp.json, e nega le skill spente", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const base = await makeBase(root);
    const projectId = await insertProject(db);
    const plugin = await materializePlugin(db, c.pluginsDir);
    await enable(db, projectId, plugin.id, {
      disabledSkills: ["beta-skill"],
      disabledHooks: ["SessionStart#1"],
    });

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => base,
    });

    // Il BASE è primo, poi la COPIA del plugin (mai la dir originale).
    const copy = join(c.runTmpDir, "plugins", plugin.slug);
    expect(result.pluginDirs).toEqual([base, copy]);
    expect(result.pluginDirs).not.toContain(plugin.dir);

    // Skill spenta assente dal disco, skill accesa presente con i suoi file.
    expect(existsSync(join(copy, "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(copy, "skills", "alpha", "rif.md"))).toBe(true);
    expect(existsSync(join(copy, "skills", "beta"))).toBe(false);
    // Comandi e file di supporto degli hook copiati normalmente.
    expect(existsSync(join(copy, "commands", "fai.md"))).toBe(true);
    expect(existsSync(join(copy, "hooks", "session-start.sh"))).toBe(true);
    // `.mcp.json` MAI copiato (invariante di sicurezza).
    expect(existsSync(join(copy, ".mcp.json"))).toBe(false);

    // hooks.json riscritto: resta solo il gruppo acceso.
    const hooks = JSON.parse(await readFile(join(copy, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string }>>;
    };
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.SessionStart?.[0]?.matcher).toBe("startup");

    // Cintura e bretelle: la deny rule usa il `name` del manifest, non lo slug.
    expect(result.disallowedTools).toEqual(["Skill(demo:beta-skill)"]);

    // L'originale sul volume non è stato toccato.
    expect(existsSync(join(plugin.dir, "skills", "beta", "SKILL.md"))).toBe(true);
    expect(existsSync(join(plugin.dir, ".mcp.json"))).toBe(true);
  });

  it("nessun plugin abilitato → liste vuote (e nessuna copia, nemmeno del base)", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const base = await makeBase(root);
    const projectId = await insertProject(db);
    // Plugin ready ma NON abilitato sul progetto.
    await materializePlugin(db, c.pluginsDir);

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => base,
    });

    expect(result).toEqual({ pluginDirs: [], disallowedTools: [] });
    expect(existsSync(join(c.runTmpDir, "plugins"))).toBe(false);
  });

  it("abilitazione disattivata o plugin non `ready` → esclusi", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const projectId = await insertProject(db);
    const off = await materializePlugin(db, c.pluginsDir);
    const notReady = await materializePlugin(db, c.pluginsDir, { status: "materializing" });
    await enable(db, projectId, off.id, { enabled: false });
    await enable(db, projectId, notReady.id);

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => null,
    });

    expect(result.pluginDirs).toEqual([]);
  });

  it("mismatch fra il `name` del manifest e quello del registro → plugin saltato con log, gli altri restano", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const projectId = await insertProject(db);
    // Il manifest sul disco dice "altro", il registro (inventario) dice "demo":
    // la dir sul volume non è più quella che il registro descrive.
    const files = pluginFiles();
    files[".claude-plugin/plugin.json"] = JSON.stringify({ name: "altro" });
    const mismatched = await materializePlugin(db, c.pluginsDir, { files });
    const good = await materializePlugin(db, c.pluginsDir);
    await enable(db, projectId, mismatched.id);
    await enable(db, projectId, good.id);

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => null,
    });

    expect(result.pluginDirs).toEqual([join(c.runTmpDir, "plugins", good.slug)]);
    expect(existsSync(join(c.runTmpDir, "plugins", mismatched.slug))).toBe(false);
    expect(c.logs.join("\n")).toContain(mismatched.slug);
    expect(c.logs.join("\n")).toMatch(/salt/i);
  });

  it("dir materializzata sparita (finestra TOCTOU) → plugin saltato con log, il run procede", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const projectId = await insertProject(db);
    const missing = await materializePlugin(db, c.pluginsDir, { onDisk: false });
    const good = await materializePlugin(db, c.pluginsDir);
    await enable(db, projectId, missing.id);
    await enable(db, projectId, good.id);

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => null,
    });

    expect(result.pluginDirs).toEqual([join(c.runTmpDir, "plugins", good.slug)]);
    expect(c.logs.join("\n")).toContain(missing.slug);
  });

  it("tutti i gruppi di hook spenti → `hooks/hooks.json` omesso dalla copia", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const projectId = await insertProject(db);
    const plugin = await materializePlugin(db, c.pluginsDir);
    await enable(db, projectId, plugin.id, {
      disabledHooks: ["SessionStart#0", "SessionStart#1"],
    });

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => null,
    });

    const copy = result.pluginDirs[0]!;
    expect(existsSync(join(copy, "hooks", "hooks.json"))).toBe(false);
    // Il resto della dir hooks (gli script) resta: solo il file che DEFINISCE
    // gli hook sparisce, ed è quello che il CLI legge.
    expect(existsSync(join(copy, "hooks", "session-start.sh"))).toBe(true);
  });

  it("spegnimento per NOME DELLA DIRECTORY quando la skill non ha `name` nel frontmatter", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const projectId = await insertProject(db);
    // `alpha` ha il name nel frontmatter, `gamma` no: per `gamma` il nome
    // dell'inventario (e quindi lo spegnimento) è quello della directory.
    const files = pluginFiles();
    files["skills/gamma/SKILL.md"] = "---\ndescription: senza name\n---\n\ncorpo gamma\n";
    const plugin = await materializePlugin(db, c.pluginsDir, { files });
    await enable(db, projectId, plugin.id, { disabledSkills: ["gamma"] });

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => null,
    });

    const copy = result.pluginDirs[0]!;
    expect(existsSync(join(copy, "skills", "gamma"))).toBe(false);
    expect(existsSync(join(copy, "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(result.disallowedTools).toEqual(["Skill(demo:gamma)"]);
  });

  it("deny rule anche per una skill spenta la cui directory non esiste più", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const projectId = await insertProject(db);
    const plugin = await materializePlugin(db, c.pluginsDir);
    // Voce rimasta in `disabled_skills` che non corrisponde ad alcuna dir (una
    // skill sparita da un aggiornamento, prima che la potatura la tolga): la
    // deny rule si emette lo stesso — è il meccanismo indipendente dalla copia.
    await enable(db, projectId, plugin.id, { disabledSkills: ["beta-skill", "sparita"] });

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => null,
    });

    expect(result.disallowedTools.sort()).toEqual([
      "Skill(demo:beta-skill)",
      "Skill(demo:sparita)",
    ]);
    // La skill che una dir ce l'ha è comunque sparita dal disco.
    expect(existsSync(join(result.pluginDirs[0]!, "skills", "beta"))).toBe(false);
  });

  it("`hooks/hooks.json` non parsabile con hook spenti → file OMESSO, col motivo nel log", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const projectId = await insertProject(db);
    // JSON rotto: non possiamo garantire che il gruppo spento non venga
    // eseguito, quindi il file non entra nella copia (in dubbio non si esegue).
    const files = pluginFiles();
    files["hooks/hooks.json"] = "{ questo non e' json";
    const plugin = await materializePlugin(db, c.pluginsDir, { files });
    await enable(db, projectId, plugin.id, { disabledHooks: ["SessionStart#1"] });

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => null,
    });

    const copy = result.pluginDirs[0]!;
    // Il plugin entra nel run (fail-open sulla PRESENZA), ma senza hook.
    expect(existsSync(copy)).toBe(true);
    expect(existsSync(join(copy, "hooks", "hooks.json"))).toBe(false);
    expect(c.logs.join("\n")).toContain("hooks/hooks.json non leggibile o non JSON");
    expect(c.logs.join("\n")).toContain("hook non caricati per questo run");
  });

  it("i symlink non sono seguiti né copiati", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const projectId = await insertProject(db);
    const plugin = await materializePlugin(db, c.pluginsDir);
    // Segreto dell'host fuori dalla dir del plugin + un link che ci punta.
    const secret = join(root, "segreto.txt");
    await writeFile(secret, "TOKEN", "utf8");
    await symlink(secret, join(plugin.dir, "skills", "alpha", "link.txt"));
    await symlink(join(root, "fuori"), join(plugin.dir, "dir-link"));
    await enable(db, projectId, plugin.id);

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => null,
    });

    const copy = result.pluginDirs[0]!;
    expect(existsSync(join(copy, "skills", "alpha", "link.txt"))).toBe(false);
    expect(existsSync(join(copy, "dir-link"))).toBe(false);
    // Nessun link nell'albero copiato.
    const links: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) links.push(join(dir, entry.name));
        else if (entry.isDirectory()) await walk(join(dir, entry.name));
      }
    };
    await walk(copy);
    expect(links).toEqual([]);
  });

  it("più plugin: ordine base, poi per slug, e le deny rule di tutti", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const base = await makeBase(root);
    const projectId = await insertProject(db);
    const first = await materializePlugin(db, c.pluginsDir, { name: "uno" });
    const second = await materializePlugin(db, c.pluginsDir, { name: "due" });
    await enable(db, projectId, second.id, { disabledSkills: ["alpha-skill"] });
    await enable(db, projectId, first.id, { disabledSkills: ["beta-skill"] });

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => base,
    });

    // `demo-N` con N crescente: l'ordine è per slug, non quello di inserimento
    // delle abilitazioni.
    const bySlug = [first, second].sort((a, b) => a.slug.localeCompare(b.slug, "en"));
    expect(result.pluginDirs).toEqual([
      base,
      ...bySlug.map((p) => join(c.runTmpDir, "plugins", p.slug)),
    ]);
    expect(result.disallowedTools.sort()).toEqual([
      "Skill(due:alpha-skill)",
      "Skill(uno:beta-skill)",
    ]);
  });

  it("plugin base assente nell'immagine → una riga di log e i plugin del progetto lo stesso", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const projectId = await insertProject(db);
    const plugin = await materializePlugin(db, c.pluginsDir);
    await enable(db, projectId, plugin.id);

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => null,
    });

    expect(result.pluginDirs).toEqual([join(c.runTmpDir, "plugins", plugin.slug)]);
    expect(c.logs.join("\n")).toMatch(/base/i);
  });

  it("slug non utilizzabile come nome di directory → saltato, e niente rm fuori dalla dir del run", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const projectId = await insertProject(db);
    // Le colonne del registro non hanno CHECK: uno slug come questo (che il
    // server non produce, ma una riga scritta a mano sì) non deve poter
    // trasformare la `rm` dello staging in una rimozione fuori dal run.
    const vittima = join(root, "vittima");
    await writeTree(vittima, { "dato.txt": "importante" });
    counter++;
    const [row] = await db
      .insert(plugins)
      .values({
        slug: "../vittima",
        name: "demo",
        sourceUrl: "https://example.com/org/demo.git",
        ref: "main",
        resolvedSha: fakeSha(counter),
        status: "ready",
        inventory: inventoryOf(),
        materializedAt: new Date(),
      })
      .returning({ id: plugins.id });
    await enable(db, projectId, row!.id);

    const result = await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => null,
    });

    expect(result.pluginDirs).toEqual([]);
    expect(existsSync(join(vittima, "dato.txt"))).toBe(true);
    expect(c.logs.join("\n")).toMatch(/salt/i);
  });

  it("la copia non lascia dir di staging accanto a quella pubblicata", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const c = await makeCase(root);
    const projectId = await insertProject(db);
    const plugin = await materializePlugin(db, c.pluginsDir);
    await enable(db, projectId, plugin.id);

    await preparePluginsForRun(db, {
      projectId,
      runTmpDir: c.runTmpDir,
      pluginsDir: c.pluginsDir,
      log: (m) => {
        c.logs.push(m);
      },
      basePluginPathFn: () => null,
    });

    expect(await readdir(join(c.runTmpDir, "plugins"))).toEqual([plugin.slug]);
    // La dir del run contiene SOLO `plugins`: nessuno staging residuo.
    expect(await readdir(c.runTmpDir)).toEqual(["plugins"]);
  });
});

// ---------------------------------------------------------------------------
// openRunPlugins
// ---------------------------------------------------------------------------

describe("openRunPlugins", () => {
  it("con plugin abilitati: opzioni complete (settingSources vuoto) e dir temporanea rimossa dal cleanup", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const pluginsDir = join(root, "plugins");
    const base = await makeBase(root);
    const projectId = await insertProject(db);
    const plugin = await materializePlugin(db, pluginsDir);
    await enable(db, projectId, plugin.id, { disabledSkills: ["beta-skill"] });

    const logs: string[] = [];
    const opened = await openRunPlugins(db, {
      projectId,
      pluginsDir,
      log: (m) => {
        logs.push(m);
      },
      basePluginPathFn: () => base,
    });

    expect(opened.options.settingSources).toBe("");
    expect(opened.options.pluginDirs?.[0]).toBe(base);
    expect(opened.options.disallowedTools).toEqual(["Skill(demo:beta-skill)"]);
    const copy = opened.options.pluginDirs![1]!;
    expect(existsSync(copy)).toBe(true);
    // La copia sta FUORI da qualunque cwd di run (dir temporanea di sistema).
    expect((await lstat(copy)).isDirectory()).toBe(true);

    await opened.cleanup();
    expect(existsSync(copy)).toBe(false);
  });

  it("senza plugin abilitati: opzioni VUOTE (nessun --setting-sources) e cleanup innocuo", async () => {
    const db = testDb.db;
    const root = await makeRoot();
    const projectId = await insertProject(db);

    const opened = await openRunPlugins(db, {
      projectId,
      pluginsDir: join(root, "plugins"),
      log: () => {},
    });

    expect(opened.options).toEqual({});
    await opened.cleanup();
    await opened.cleanup();
  });

  it("senza `pluginsDir` configurata: opzioni vuote e nessuna query", async () => {
    const db = testDb.db;
    const projectId = await insertProject(db);

    const opened = await openRunPlugins(db, { projectId, log: () => {} });

    expect(opened.options).toEqual({});
    await opened.cleanup();
  });

  it("un errore inatteso non fa mai fallire il run: opzioni vuote e log", async () => {
    const root = await makeRoot();
    const projectId = "non-un-uuid";
    const logs: string[] = [];

    const opened = await openRunPlugins(testDb.db, {
      projectId,
      pluginsDir: join(root, "plugins"),
      log: (m) => {
        logs.push(m);
      },
    });

    expect(opened.options).toEqual({});
    expect(logs.join("\n")).toMatch(/plugin/i);
    await opened.cleanup();
  });
});
