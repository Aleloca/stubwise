import {
  encrypt,
  gitAccounts,
  graphJobs,
  projects,
  repoGraphs,
  repositories,
  type Db,
  type GraphJob,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphifyRunOptions, GraphifyRunResult } from "./graphify-cli.js";
import { GRAPH_SETUP_BRANCH, runGraphSetupPr, type GraphSetupPrDeps } from "./setup-pr.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
/** Volume dei grafi (finto) e worktree finto: dir reali, ricreate a ogni test. */
let graphsDir: string;
let worktreeDir: string;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

beforeEach(async () => {
  graphsDir = await mkdtemp(join(tmpdir(), "stubwise-graphs-"));
  worktreeDir = await mkdtemp(join(tmpdir(), "stubwise-fakewt-"));
});

afterEach(async () => {
  await testDb.db.delete(projects); // repositories/repo_graphs/graph_jobs cascano.
  await testDb.db.delete(gitAccounts);
  await rm(graphsDir, { recursive: true, force: true });
  await rm(worktreeDir, { recursive: true, force: true });
});

afterAll(async () => {
  await testDb.stop();
});

const silentLogger = { warn: () => {}, error: () => {} };

/** Scrive gli artefatti del grafo sul volume finto (quelli richiesti + opzionali). */
async function seedGraphFiles(
  repositoryId: string,
  opts: { html?: boolean; missing?: string[] } = {},
): Promise<string> {
  const outDir = join(graphsDir, repositoryId, "graphify-out");
  await mkdir(join(outDir, "cache"), { recursive: true });
  const files: Record<string, string> = {
    "graph.json": '{"nodes":[]}',
    "GRAPH_REPORT.md": "# Report\n",
    "manifest.json": '{"version":1}',
  };
  if (opts.html !== false) files["graph.html"] = "<html></html>";
  for (const [name, body] of Object.entries(files)) {
    if (opts.missing?.includes(name)) continue;
    await writeFile(join(outDir, name), body);
  }
  // Artefatti che NON devono mai finire nel repo.
  await writeFile(join(outDir, "cost.json"), '{"usd":1}');
  await writeFile(join(outDir, "cache", "blob.bin"), "x");
  return outDir;
}

/** Fake del MirrorManager: worktree finto (dir reale) + push registrati. */
function fakeMirrors(): GraphSetupPrDeps["mirrors"] & {
  readonly opens: number;
  readonly closes: number;
  readonly branches: string[];
  readonly pushes: { branch: string; force: boolean }[];
} {
  const state = {
    opens: 0,
    closes: 0,
    branches: [] as string[],
    pushes: [] as { branch: string; force: boolean }[],
  };
  return {
    get opens() {
      return state.opens;
    },
    get closes() {
      return state.closes;
    },
    get branches() {
      return state.branches;
    },
    get pushes() {
      return state.pushes;
    },
    openWorktree: async (_project: unknown, branch: string) => {
      state.opens++;
      state.branches.push(branch);
      return {
        dir: worktreeDir,
        remove: async () => {
          state.closes++;
        },
      };
    },
    pushBranch: async (_project: unknown, branch: string, opts?: { force?: boolean }) => {
      state.pushes.push({ branch, force: opts?.force === true });
    },
  } as unknown as GraphSetupPrDeps["mirrors"] & {
    readonly opens: number;
    readonly closes: number;
    readonly branches: string[];
    readonly pushes: { branch: string; force: boolean }[];
  };
}

/** Fake del CLI graphify: registra le invocazioni (qui solo `install`). */
function fakeGraphify(
  result: GraphifyRunResult = { exitCode: 0, output: "" },
): { runner: GraphSetupPrDeps["graphify"]; calls: GraphifyRunOptions[] } {
  const calls: GraphifyRunOptions[] = [];
  return {
    calls,
    runner: async (opts) => {
      calls.push(opts);
      return result;
    },
  };
}

/**
 * Fake di git nel worktree: registra gli argv. `diff --cached` risponde con un
 * path staged (ci sono modifiche da committare), gli altri comandi "".
 */
function fakeGit(staged = "graphify-out/graph.json"): {
  fn: NonNullable<GraphSetupPrDeps["gitFn"]>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: async (args) => {
      calls.push(args);
      return args[0] === "diff" ? staged : "";
    },
  };
}

function fakeProvider(url = "https://git.example/pr/1"): {
  getProviderFn: NonNullable<GraphSetupPrDeps["getProviderFn"]>;
  openPullRequest: ReturnType<typeof vi.fn>;
} {
  const openPullRequest = vi.fn(async () => ({ url }));
  return { openPullRequest, getProviderFn: () => ({ openPullRequest }) };
}

function makeDeps(db: Db, overrides: Partial<GraphSetupPrDeps> = {}): GraphSetupPrDeps {
  return {
    db,
    mirrors: fakeMirrors(),
    graphify: fakeGraphify().runner,
    logger: silentLogger,
    encryptionKey: ENCRYPTION_KEY,
    graphsDir,
    labelEnabled: true,
    timeoutMs: 600_000,
    gitFn: fakeGit().fn,
    getProviderFn: fakeProvider().getProviderFn,
    ...overrides,
  };
}

async function createRepo(db: Db): Promise<{ projectId: string; repositoryId: string }> {
  const [account] = await db
    .insert(gitAccounts)
    .values({
      name: `Account ${randomUUID()}`,
      provider: "github",
      encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
    })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ name: "Progetto grafo", slug: `gr-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning();
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: "Repo grafo",
      slug: `repo-${randomUUID()}`,
      provider: "github",
      gitAccountId: account!.id,
      repoUrl: "https://example.com/repo.git",
      defaultBranch: "main",
    })
    .returning();
  return { projectId: project!.id, repositoryId: repository!.id };
}

/** Job `setup_pr` già RECLAMATO (running): lo stato in cui il poller lo passa. */
async function claimedJob(db: Db, repositoryId: string): Promise<GraphJob> {
  const [job] = await db
    .insert(graphJobs)
    .values({ repositoryId, kind: "setup_pr", status: "running", claimedAt: new Date() })
    .returning();
  return job!;
}

async function getGraph(db: Db, repositoryId: string) {
  const [row] = await db.select().from(repoGraphs).where(eq(repoGraphs.repositoryId, repositoryId));
  return row;
}

async function getJob(db: Db, id: string) {
  const [row] = await db.select().from(graphJobs).where(eq(graphJobs.id, id));
  return row!;
}

/** Repo col grafo pronto (`done`) e gli artefatti sul volume. */
async function readyRepo(
  db: Db,
  opts: { html?: boolean; missing?: string[]; setupPrUrl?: string } = {},
): Promise<{ repositoryId: string; job: GraphJob }> {
  const { repositoryId } = await createRepo(db);
  await db.insert(repoGraphs).values({
    repositoryId,
    status: "done",
    commitSha: "abc1234",
    ...(opts.setupPrUrl ? { setupPrUrl: opts.setupPrUrl } : {}),
  });
  await seedGraphFiles(repositoryId, opts);
  return { repositoryId, job: await claimedJob(db, repositoryId) };
}

function read(relative: string): Promise<string> {
  return readFile(join(worktreeDir, relative), "utf8");
}

describe("runGraphSetupPr", () => {
  it("copia gli artefatti, scrive la configurazione, committa, pusha e apre la PR", async () => {
    const db = testDb.db;
    const { repositoryId, job } = await readyRepo(db);
    const mirrors = fakeMirrors();
    const git = fakeGit();
    const provider = fakeProvider("https://git.example/pr/42");

    const ok = await runGraphSetupPr(
      makeDeps(db, { mirrors, gitFn: git.fn, getProviderFn: provider.getProviderFn }),
      job,
    );

    expect(ok).toBe(true);
    // Worktree scrivibile sul branch dedicato, aperto e chiuso una sola volta.
    expect(mirrors.branches).toEqual([GRAPH_SETUP_BRANCH]);
    expect(mirrors.opens).toBe(1);
    expect(mirrors.closes).toBe(1);

    // Artefatti copiati dal volume, MAI cache/ né cost.json.
    expect(await read("graphify-out/graph.json")).toBe('{"nodes":[]}');
    expect(await read("graphify-out/GRAPH_REPORT.md")).toBe("# Report\n");
    expect(await read("graphify-out/manifest.json")).toBe('{"version":1}');
    expect(await read("graphify-out/graph.html")).toBe("<html></html>");
    expect(existsSync(join(worktreeDir, "graphify-out", "cost.json"))).toBe(false);
    expect(existsSync(join(worktreeDir, "graphify-out", "cache"))).toBe(false);

    // File di configurazione.
    const gitignore = await read(".gitignore");
    expect(gitignore).toContain("graphify-out/cost.json");
    expect(gitignore).toContain("graphify-out/cache/");
    expect(await read(".gitattributes")).toContain("graphify-out/graph.json merge=graphify-union");
    expect(await read(".graphifyignore")).toContain("node_modules/");
    const mcp = JSON.parse(await read(".mcp.json")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(mcp.mcpServers.graphify).toEqual({
      command: "uvx",
      args: [
        "--from",
        "graphifyy[mcp]==0.9.28",
        "python",
        "-m",
        "graphify.serve",
        "graphify-out/graph.json",
      ],
    });
    const claudeMd = await read("CLAUDE.md");
    expect(claudeMd).toContain("<!-- graphify:start -->");
    expect(claudeMd).toContain("<!-- graphify:end -->");
    expect(claudeMd).toContain("graphify query");

    // git: SOLO path espliciti (mai -A), poi commit; push forzato del branch.
    const add = git.calls.find((c) => c[0] === "add");
    expect(add).toBeDefined();
    expect(add).not.toContain("-A");
    // `--force`: un .gitignore preesistente su graphify-out/ non deve far
    // fallire la PR (versionare quei file è lo scopo del setup).
    expect(add).toContain("--force");
    expect(add).toContain("graphify-out/graph.json");
    expect(add).toContain(".mcp.json");
    expect(add).toContain("CLAUDE.md");
    expect(git.calls.some((c) => c.includes("commit"))).toBe(true);
    expect(mirrors.pushes).toEqual([{ branch: GRAPH_SETUP_BRANCH, force: true }]);

    // PR aperta sul branch e URL salvato.
    expect(provider.openPullRequest).toHaveBeenCalledTimes(1);
    const prArgs = provider.openPullRequest.mock.calls[0] as unknown[];
    expect(prArgs[1]).toMatchObject({ branch: GRAPH_SETUP_BRANCH });
    expect((prArgs[1] as { body: string }).body).toContain("graphify hook install");
    expect((await getGraph(db, repositoryId))?.setupPrUrl).toBe("https://git.example/pr/42");
    // Il job NON viene chiuso dal runner: lo fa il poller (completeGraphJob).
    expect((await getJob(db, job.id)).status).toBe("running");
  });

  it("graph.html assente sul volume: PR aperta comunque, senza copiarlo", async () => {
    const db = testDb.db;
    const { job } = await readyRepo(db, { html: false });

    const ok = await runGraphSetupPr(makeDeps(db), job);

    expect(ok).toBe(true);
    expect(existsSync(join(worktreeDir, "graphify-out", "graph.html"))).toBe(false);
    expect(existsSync(join(worktreeDir, "graphify-out", "graph.json"))).toBe(true);
  });

  it("grafo non done: fallisce SOLO il job, senza aprire il worktree", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    await db.insert(repoGraphs).values({ repositoryId, status: "none" });
    const job = await claimedJob(db, repositoryId);
    const mirrors = fakeMirrors();

    const ok = await runGraphSetupPr(makeDeps(db, { mirrors }), job);

    expect(ok).toBe(false);
    expect(mirrors.opens).toBe(0);
    const failed = await getJob(db, job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/genera prima il grafo/i);
    // Il GRAFO non viene toccato: resta lo stato reale (none), non failed.
    expect((await getGraph(db, repositoryId))?.status).toBe("none");
  });

  it("grafo done ma artefatti assenti sul volume: fallisce solo il job", async () => {
    const db = testDb.db;
    const { repositoryId, job } = await readyRepo(db, { missing: ["graph.json"] });
    const mirrors = fakeMirrors();

    const ok = await runGraphSetupPr(makeDeps(db, { mirrors }), job);

    expect(ok).toBe(false);
    expect(mirrors.opens).toBe(0);
    expect((await getJob(db, job.id)).error).toMatch(/graph\.json/);
    // Lo stato del grafo NON viene marcato failed dal setup PR.
    expect((await getGraph(db, repositoryId))?.status).toBe("done");
  });

  it(".mcp.json esistente: la voce graphify si aggiunge, gli altri server restano", async () => {
    const db = testDb.db;
    const { job } = await readyRepo(db);
    await writeFile(
      join(worktreeDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { stubwise: { command: "npx", args: ["-y", "@stubwise/mcp"] } } }),
    );

    const ok = await runGraphSetupPr(makeDeps(db), job);

    expect(ok).toBe(true);
    const mcp = JSON.parse(await read(".mcp.json")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(mcp.mcpServers.stubwise).toEqual({ command: "npx", args: ["-y", "@stubwise/mcp"] });
    expect(mcp.mcpServers.graphify?.command).toBe("uvx");
  });

  it(".mcp.json malformato: fallisce solo il job e NON sovrascrive il file", async () => {
    const db = testDb.db;
    const { repositoryId, job } = await readyRepo(db);
    await writeFile(join(worktreeDir, ".mcp.json"), "{ questo non è json");
    const mirrors = fakeMirrors();

    const ok = await runGraphSetupPr(makeDeps(db, { mirrors }), job);

    expect(ok).toBe(false);
    expect(await read(".mcp.json")).toBe("{ questo non è json");
    expect((await getJob(db, job.id)).error).toMatch(/\.mcp\.json/);
    expect((await getGraph(db, repositoryId))?.status).toBe("done");
    // Worktree comunque chiuso.
    expect(mirrors.closes).toBe(1);
  });

  it("CLAUDE.md con sezione già presente: sostituita, non duplicata", async () => {
    const db = testDb.db;
    const { job } = await readyRepo(db);
    await writeFile(
      join(worktreeDir, "CLAUDE.md"),
      "# Progetto\n\nRegole del repo.\n\n<!-- graphify:start -->\nvecchia sezione\n<!-- graphify:end -->\n\n## Altro\n",
    );

    const ok = await runGraphSetupPr(makeDeps(db), job);

    expect(ok).toBe(true);
    const claudeMd = await read("CLAUDE.md");
    expect(claudeMd.match(/<!-- graphify:start -->/g)).toHaveLength(1);
    expect(claudeMd).not.toContain("vecchia sezione");
    // Il resto del file è preservato (anche ciò che segue la sezione).
    expect(claudeMd).toContain("Regole del repo.");
    expect(claudeMd).toContain("## Altro");
  });

  it(".gitignore e .gitattributes esistenti: append idempotente senza duplicati", async () => {
    const db = testDb.db;
    const { job } = await readyRepo(db);
    await writeFile(join(worktreeDir, ".gitignore"), "node_modules\ngraphify-out/cache/\n");
    await writeFile(join(worktreeDir, ".gitattributes"), "* text=auto\n");

    const ok = await runGraphSetupPr(makeDeps(db), job);

    expect(ok).toBe(true);
    const gitignore = await read(".gitignore");
    expect(gitignore).toContain("node_modules\n");
    expect(gitignore.match(/graphify-out\/cache\//g)).toHaveLength(1);
    expect(gitignore).toContain("graphify-out/cost.json");
    const gitattributes = await read(".gitattributes");
    expect(gitattributes).toContain("* text=auto");
    expect(gitattributes.match(/merge=graphify-union/g)).toHaveLength(1);
  });

  it(".graphifyignore PERSONALIZZATO dal team: NON viene toccato", async () => {
    const db = testDb.db;
    const { job } = await readyRepo(db);
    await writeFile(join(worktreeDir, ".graphifyignore"), "solo-mio/\n");

    await runGraphSetupPr(makeDeps(db), job);

    expect(await read(".graphifyignore")).toBe("solo-mio/\n");
  });

  it(".graphifyignore = starter legacy di piattaforma: la PR lo aggiorna al corrente", async () => {
    const db = testDb.db;
    const { job } = await readyRepo(db);
    await writeFile(
      join(worktreeDir, ".graphifyignore"),
      "# Percorsi esclusi dall'estrazione del grafo (graphify).\nnode_modules/\ndist/\nbuild/\ncoverage/\n",
    );

    await runGraphSetupPr(makeDeps(db), job);

    const content = await read(".graphifyignore");
    expect(content).toContain("**/migration.sql");
    expect(content).toContain("tsconfig*.json");
  });

  it("installa la skill project-scoped nel worktree", async () => {
    const db = testDb.db;
    const { job } = await readyRepo(db);
    const graphify = fakeGraphify();

    await runGraphSetupPr(makeDeps(db, { graphify: graphify.runner }), job);

    expect(graphify.calls).toHaveLength(1);
    expect(graphify.calls[0]?.args).toEqual(["install", "--project", "--platform", "claude"]);
    expect(graphify.calls[0]?.cwd).toBe(worktreeDir);
  });

  it("skill install fallita: warning, la PR si apre comunque", async () => {
    const db = testDb.db;
    const { repositoryId, job } = await readyRepo(db);
    const graphify = fakeGraphify({ exitCode: 1, output: "uv non trovato" });
    const warn = vi.fn();

    const ok = await runGraphSetupPr(
      makeDeps(db, { graphify: graphify.runner, logger: { warn, error: () => {} } }),
      job,
    );

    expect(ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect((await getGraph(db, repositoryId))?.setupPrUrl).toBe("https://git.example/pr/1");
  });

  it("apertura PR fallita: solo il job a failed, worktree chiuso", async () => {
    const db = testDb.db;
    const { repositoryId, job } = await readyRepo(db);
    const mirrors = fakeMirrors();
    const getProviderFn: GraphSetupPrDeps["getProviderFn"] = () => ({
      openPullRequest: async () => {
        throw new Error("403 permessi insufficienti");
      },
    });

    const ok = await runGraphSetupPr(makeDeps(db, { mirrors, getProviderFn }), job);

    expect(ok).toBe(false);
    expect(mirrors.closes).toBe(1);
    expect((await getJob(db, job.id)).error).toContain("403 permessi insufficienti");
    const graph = await getGraph(db, repositoryId);
    expect(graph?.status).toBe("done"); // il grafo resta valido
    expect(graph?.setupPrUrl).toBeNull();
  });

  it("PR già esistente sul provider: riusa l'URL già salvato e conclude con successo", async () => {
    const db = testDb.db;
    const { repositoryId, job } = await readyRepo(db, { setupPrUrl: "https://git.example/pr/7" });
    const getProviderFn: GraphSetupPrDeps["getProviderFn"] = () => ({
      openPullRequest: async () => {
        throw new Error("GitHub API request failed with status 422: A pull request already exists");
      },
    });

    const ok = await runGraphSetupPr(makeDeps(db, { getProviderFn }), job);

    expect(ok).toBe(true);
    expect((await getGraph(db, repositoryId))?.setupPrUrl).toBe("https://git.example/pr/7");
  });

  it("PR già esistente senza URL noto: fallisce solo il job", async () => {
    const db = testDb.db;
    const { repositoryId, job } = await readyRepo(db);
    const getProviderFn: GraphSetupPrDeps["getProviderFn"] = () => ({
      openPullRequest: async () => {
        throw new Error("GitHub API request failed with status 422: A pull request already exists");
      },
    });

    const ok = await runGraphSetupPr(makeDeps(db, { getProviderFn }), job);

    expect(ok).toBe(false);
    expect((await getJob(db, job.id)).error).toMatch(/already exists/i);
    expect((await getGraph(db, repositoryId))?.status).toBe("done");
  });

  it("niente da committare (setup già sul default branch) senza PR nota: fallisce solo il job", async () => {
    const db = testDb.db;
    const { repositoryId, job } = await readyRepo(db);
    const provider = fakeProvider();

    const ok = await runGraphSetupPr(
      makeDeps(db, { gitFn: fakeGit("").fn, getProviderFn: provider.getProviderFn }),
      job,
    );

    expect(ok).toBe(false);
    expect(provider.openPullRequest).not.toHaveBeenCalled();
    expect((await getJob(db, job.id)).error).toMatch(/già/i);
    expect((await getGraph(db, repositoryId))?.status).toBe("done");
  });

  it("niente da committare ma PR già nota: successo, URL invariato", async () => {
    const db = testDb.db;
    const { repositoryId, job } = await readyRepo(db, { setupPrUrl: "https://git.example/pr/7" });
    const provider = fakeProvider();

    const ok = await runGraphSetupPr(
      makeDeps(db, { gitFn: fakeGit("").fn, getProviderFn: provider.getProviderFn }),
      job,
    );

    expect(ok).toBe(true);
    expect(provider.openPullRequest).not.toHaveBeenCalled();
    expect((await getGraph(db, repositoryId))?.setupPrUrl).toBe("https://git.example/pr/7");
  });

  it("errore git nel worktree: solo il job a failed, worktree chiuso", async () => {
    const db = testDb.db;
    const { repositoryId, job } = await readyRepo(db);
    const mirrors = fakeMirrors();
    const gitFn: NonNullable<GraphSetupPrDeps["gitFn"]> = async (args) => {
      if (args.includes("commit")) throw new Error("git commit: exit 128");
      return args[0] === "diff" ? "graphify-out/graph.json" : "";
    };

    const ok = await runGraphSetupPr(makeDeps(db, { mirrors, gitFn }), job);

    expect(ok).toBe(false);
    expect(mirrors.closes).toBe(1);
    expect((await getJob(db, job.id)).error).toContain("git commit: exit 128");
    expect((await getGraph(db, repositoryId))?.status).toBe("done");
  });
});
