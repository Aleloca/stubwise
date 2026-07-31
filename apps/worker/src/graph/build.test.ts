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
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runGraphBuild, type GraphBuildDeps } from "./build.js";
import type { GraphifyRunOptions, GraphifyRunResult } from "./graphify-cli.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);
const GRAPHS_DIR = "/graphs";
const HEAD_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00fedcba9";
const WORKTREE_DIR = "/tmp/fake-graph-wt";

/** Riga di riepilogo REALE di `graphify extract` (v0.9.28, percorso clusterizzato). */
const EXTRACT_OK = `[graphify extract] scanning...\n[graphify extract] wrote /graphs/x/graphify-out/graph.json: 5701 nodes, 11463 edges, 263 communities\n[graphify extract] wrote /graphs/x/graphify-out/.graphify_analysis.json`;

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects); // repositories/repo_graphs/graph_jobs cascano.
  await testDb.db.delete(gitAccounts);
});

afterAll(async () => {
  await testDb.stop();
});

const silentLogger = { warn: () => {}, error: () => {} };

/** Fake del CLI graphify: registra ogni invocazione e delega l'esito a `behaviour`
 * (default: tutto ok, con la riga di riepilogo reale sull'extract). */
function fakeGraphify(
  behaviour: (args: string[]) => GraphifyRunResult | Promise<GraphifyRunResult> = () => ({
    exitCode: 0,
    output: "",
  }),
): { runner: GraphBuildDeps["graphify"]; calls: GraphifyRunOptions[] } {
  const calls: GraphifyRunOptions[] = [];
  return {
    calls,
    runner: async (opts) => {
      calls.push(opts);
      if (opts.args[0] === "extract") {
        const custom = await behaviour(opts.args);
        return custom.exitCode === 0 && custom.output === ""
          ? { exitCode: 0, output: EXTRACT_OK }
          : custom;
      }
      return behaviour(opts.args);
    },
  };
}

/** Fake MirrorManager: HEAD fisso e worktree effimero che conta aperture/chiusure. */
function fakeMirrors(dir: string = WORKTREE_DIR): GraphBuildDeps["mirrors"] & {
  readonly opens: number;
  readonly closes: number;
  readonly shas: string[];
} {
  const state = { opens: 0, closes: 0, shas: [] as string[] };
  return {
    get opens() {
      return state.opens;
    },
    get closes() {
      return state.closes;
    },
    get shas() {
      return state.shas;
    },
    resolveDefaultBranchHead: async () => HEAD_SHA,
    withWorktreeAtSha: (async (_project: unknown, sha: string, fn: (dir: string) => Promise<unknown>) => {
      state.opens++;
      state.shas.push(sha);
      try {
        return await fn(dir);
      } finally {
        state.closes++;
      }
    }) as GraphBuildDeps["mirrors"]["withWorktreeAtSha"],
  } as GraphBuildDeps["mirrors"] & {
    readonly opens: number;
    readonly closes: number;
    readonly shas: string[];
  };
}

function makeDeps(db: Db, overrides: Partial<GraphBuildDeps> = {}): GraphBuildDeps {
  return {
    db,
    mirrors: fakeMirrors(),
    graphify: fakeGraphify().runner,
    logger: silentLogger,
    encryptionKey: ENCRYPTION_KEY,
    graphsDir: GRAPHS_DIR,
    labelEnabled: true,
    timeoutMs: 1_200_000,
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

/** Job `build` già RECLAMATO (running): è lo stato in cui il poller passa il job
 * al runner, ed è quello su cui failGraphJob è status-guarded. */
async function claimedJob(db: Db, repositoryId: string, force = false): Promise<GraphJob> {
  const [job] = await db
    .insert(graphJobs)
    .values({ repositoryId, kind: "build", status: "running", force, claimedAt: new Date() })
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

describe("runGraphBuild — esclusioni di piattaforma (.graphifyignore)", () => {
  it("repo SENZA .graphifyignore: il default di piattaforma è nel worktree PRIMA dell'extract", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    const dir = await mkdtemp(join(tmpdir(), "graph-wt-"));
    try {
      // Cattura l'esistenza del file NEL momento dell'extract: l'ordine conta
      // (scritto dopo non escluderebbe nulla).
      let presentAtExtract = false;
      const graphify = fakeGraphify((args) => {
        if (args[0] === "extract") presentAtExtract = existsSync(join(dir, ".graphifyignore"));
        return { exitCode: 0, output: "" };
      });

      const ok = await runGraphBuild(
        makeDeps(db, { graphify: graphify.runner, mirrors: fakeMirrors(dir) }),
        job,
      );

      expect(ok).toBe(true);
      expect(presentAtExtract).toBe(true);
      const content = await readFile(join(dir, ".graphifyignore"), "utf8");
      expect(content).toContain("**/migration.sql");
      expect(content).toContain("**/migrations/**");
      expect(content).toContain("node_modules/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("repo CON .graphifyignore proprio: il file del team resta intatto", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    const dir = await mkdtemp(join(tmpdir(), "graph-wt-"));
    try {
      await writeFile(join(dir, ".graphifyignore"), "solo-del-team/\n", "utf8");

      const ok = await runGraphBuild(makeDeps(db, { mirrors: fakeMirrors(dir) }), job);

      expect(ok).toBe(true);
      expect(await readFile(join(dir, ".graphifyignore"), "utf8")).toBe("solo-del-team/\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runGraphBuild", () => {
  it("estrae, etichetta ed esporta l'html, poi porta repo_graphs a done con i contatori", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    const graphify = fakeGraphify();
    const mirrors = fakeMirrors();

    const ok = await runGraphBuild(makeDeps(db, { graphify: graphify.runner, mirrors }), job);

    expect(ok).toBe(true);
    // SEQUENZA: extract → clustering col backend claude-cli → export html.
    expect(graphify.calls.map((c) => c.args)).toEqual([
      ["extract", WORKTREE_DIR, "--code-only"],
      ["cluster-only", WORKTREE_DIR, "--backend=claude-cli"],
      ["export", "html"],
    ]);
    // Worktree aperto (a HEAD del default branch) e chiuso una sola volta.
    expect(mirrors.shas).toEqual([HEAD_SHA]);
    expect(mirrors.opens).toBe(1);
    expect(mirrors.closes).toBe(1);

    const graph = await getGraph(db, repositoryId);
    expect(graph?.status).toBe("done");
    expect(graph?.commitSha).toBe(HEAD_SHA);
    expect(graph?.nodeCount).toBe(5701);
    expect(graph?.edgeCount).toBe(11463);
    expect(graph?.communityCount).toBe(263);
    expect(graph?.labeled).toBe(true);
    expect(graph?.error).toBeNull();
    expect(graph?.generatedAt).not.toBeNull();
    // Il job NON viene chiuso dal runner: lo fa il chiamante (poller).
    expect((await getJob(db, job.id)).status).toBe("running");
  });

  it("passa GRAPHIFY_OUT del repository a ogni invocazione e gira nel worktree", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    const graphify = fakeGraphify();

    await runGraphBuild(makeDeps(db, { graphify: graphify.runner }), job);

    const expectedOut = `${GRAPHS_DIR}/${repositoryId}/graphify-out`;
    expect(graphify.calls).not.toHaveLength(0);
    for (const call of graphify.calls) {
      expect(call.extraEnv?.GRAPHIFY_OUT).toBe(expectedOut);
      expect(call.cwd).toBe(WORKTREE_DIR);
      expect(call.timeoutMs).toBe(1_200_000);
    }
  });

  it("marca repo_graphs running PRIMA di invocare graphify", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    let statusDuranteExtract: string | undefined;
    const graphify = fakeGraphify();
    const spying: GraphBuildDeps["graphify"] = async (opts) => {
      if (opts.args[0] === "extract") {
        statusDuranteExtract = (await getGraph(db, repositoryId))?.status;
      }
      return graphify.runner(opts);
    };

    await runGraphBuild(makeDeps(db, { graphify: spying }), job);

    expect(statusDuranteExtract).toBe("running");
  });

  it("passa --force solo se il job lo richiede", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId, true);
    const graphify = fakeGraphify();

    await runGraphBuild(makeDeps(db, { graphify: graphify.runner }), job);

    expect(graphify.calls[0]?.args).toEqual(["extract", WORKTREE_DIR, "--code-only", "--force"]);
  });

  it("labeling fallito: ripiega su --no-label, labeled=false, build comunque done", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    const graphify = fakeGraphify((args) =>
      args.includes("--backend=claude-cli")
        ? { exitCode: 1, output: "claude: not logged in" }
        : { exitCode: 0, output: "" },
    );

    const ok = await runGraphBuild(makeDeps(db, { graphify: graphify.runner }), job);

    expect(ok).toBe(true);
    expect(graphify.calls.map((c) => c.args)).toEqual([
      ["extract", WORKTREE_DIR, "--code-only"],
      ["cluster-only", WORKTREE_DIR, "--backend=claude-cli"],
      ["cluster-only", WORKTREE_DIR, "--no-label"],
      ["export", "html"],
    ]);
    const graph = await getGraph(db, repositoryId);
    expect(graph?.status).toBe("done");
    expect(graph?.labeled).toBe(false);
    expect(graph?.nodeCount).toBe(5701);
  });

  it("labeling disabilitato: un solo clustering con --no-label", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    const graphify = fakeGraphify();

    await runGraphBuild(makeDeps(db, { graphify: graphify.runner, labelEnabled: false }), job);

    expect(graphify.calls.map((c) => c.args)).toEqual([
      ["extract", WORKTREE_DIR, "--code-only"],
      ["cluster-only", WORKTREE_DIR, "--no-label"],
      ["export", "html"],
    ]);
    expect((await getGraph(db, repositoryId))?.labeled).toBe(false);
  });

  it("clustering fallito anche in fallback: il grafo resta valido (done)", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    const graphify = fakeGraphify((args) =>
      args[0] === "cluster-only" ? { exitCode: 2, output: "clustering ko" } : { exitCode: 0, output: "" },
    );

    const ok = await runGraphBuild(makeDeps(db, { graphify: graphify.runner }), job);

    expect(ok).toBe(true);
    expect((await getGraph(db, repositoryId))?.status).toBe("done");
  });

  it("export html fallito: il grafo resta valido (done)", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    const graphify = fakeGraphify((args) =>
      args[0] === "export" ? { exitCode: 1, output: "html ko" } : { exitCode: 0, output: "" },
    );

    const ok = await runGraphBuild(makeDeps(db, { graphify: graphify.runner }), job);

    expect(ok).toBe(true);
    expect((await getGraph(db, repositoryId))?.status).toBe("done");
  });

  it("extract fallito: job e repo_graphs a failed con l'errore, worktree chiuso", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    const mirrors = fakeMirrors();
    const graphify = fakeGraphify((args) =>
      args[0] === "extract"
        ? { exitCode: 1, output: "tree-sitter: parser mancante" }
        : { exitCode: 0, output: "" },
    );

    const ok = await runGraphBuild(makeDeps(db, { graphify: graphify.runner, mirrors }), job);

    expect(ok).toBe(false);
    // Nessuna invocazione dopo l'extract fallito.
    expect(graphify.calls.map((c) => c.args[0])).toEqual(["extract"]);
    // Worktree chiuso anche sul percorso d'errore.
    expect(mirrors.opens).toBe(1);
    expect(mirrors.closes).toBe(1);

    const failedJob = await getJob(db, job.id);
    expect(failedJob.status).toBe("failed");
    expect(failedJob.error).toContain("tree-sitter: parser mancante");
    const graph = await getGraph(db, repositoryId);
    expect(graph?.status).toBe("failed");
    expect(graph?.error).toContain("tree-sitter: parser mancante");
    expect(graph?.generatedAt).toBeNull();
  });

  it("mirror irraggiungibile: failed senza aver invocato graphify", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    const graphify = fakeGraphify();
    const mirrors = {
      ...fakeMirrors(),
      resolveDefaultBranchHead: async () => {
        throw new Error("git fetch fallito");
      },
    } as GraphBuildDeps["mirrors"];

    const ok = await runGraphBuild(makeDeps(db, { graphify: graphify.runner, mirrors }), job);

    expect(ok).toBe(false);
    expect(graphify.calls).toHaveLength(0);
    expect((await getJob(db, job.id)).error).toContain("git fetch fallito");
    expect((await getGraph(db, repositoryId))?.status).toBe("failed");
  });

  it("riepilogo dell'extract non parsabile: done senza contatori", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    const job = await claimedJob(db, repositoryId);
    const graphify = fakeGraphify((args) =>
      args[0] === "extract" ? { exitCode: 0, output: "nessun riepilogo qui" } : { exitCode: 0, output: "" },
    );

    const ok = await runGraphBuild(makeDeps(db, { graphify: graphify.runner }), job);

    expect(ok).toBe(true);
    const graph = await getGraph(db, repositoryId);
    expect(graph?.status).toBe("done");
    expect(graph?.nodeCount).toBeNull();
    expect(graph?.edgeCount).toBeNull();
    expect(graph?.communityCount).toBeNull();
  });

  it("una rigenerazione riusa la riga esistente (upsert) e ne azzera l'errore", async () => {
    const db = testDb.db;
    const { repositoryId } = await createRepo(db);
    await db
      .insert(repoGraphs)
      .values({ repositoryId, status: "failed", error: "vecchio errore", nodeCount: 1 });
    const job = await claimedJob(db, repositoryId);

    const ok = await runGraphBuild(makeDeps(db), job);

    expect(ok).toBe(true);
    const rows = await db.select().from(repoGraphs).where(eq(repoGraphs.repositoryId, repositoryId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("done");
    expect(rows[0]?.error).toBeNull();
    expect(rows[0]?.nodeCount).toBe(5701);
  });
});
