import { gitAccounts, graphJobs, projects, repoGraphs, type Db, type GraphJob } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createProjectSerializer, type ProjectSerializer } from "../handler.js";
import type { GraphBuildDeps } from "./build.js";
import type { GraphSetupPrDeps } from "./setup-pr.js";
import { failGraphJob, failGraphJobOnly, GRAPH_STALE_MINUTES, MAX_GRAPH_ATTEMPTS } from "./queue.js";
import {
  pollGraphJobsOnce,
  startGraphPoller,
  type GraphPollerDeps,
  type RunGraphBuildFn,
  type RunGraphSetupPrFn,
} from "./poller.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  // repositories → repo_graphs / graph_jobs cascano dal progetto.
  await testDb.db.delete(projects);
  await testDb.db.delete(gitAccounts);
});

afterAll(async () => {
  await testDb.stop();
});

const silentLogger = { warn: () => {}, error: () => {} };

/** Mirror/CLI non devono MAI essere toccati: i runner del grafo sono mockati. */
const boom = async (): Promise<never> => {
  throw new Error("mirrors non deve essere usato: i runner del grafo sono mockati");
};
const explodingMirrors = {
  resolveDefaultBranchHead: boom,
  withWorktreeAtSha: boom,
  openWorktree: boom,
  pushBranch: boom,
} as unknown as GraphPollerDeps["mirrors"];

const explodingGraphify: GraphBuildDeps["graphify"] = async () => {
  throw new Error("il CLI graphify non deve essere invocato: runGraphBuild è mockato");
};

function makeDeps(db: Db, overrides: Partial<GraphPollerDeps> = {}): GraphPollerDeps {
  return {
    db,
    mirrors: explodingMirrors,
    graphify: explodingGraphify,
    logger: silentLogger,
    encryptionKey: ENCRYPTION_KEY,
    graphsDir: "/graphs",
    labelEnabled: true,
    timeoutMs: 1_200_000,
    serializer: createProjectSerializer(),
    ...overrides,
  };
}

interface InsertJobOpts {
  repositoryId: string;
  kind?: "build" | "setup_pr";
  status?: "queued" | "running" | "done" | "failed";
  attempts?: number;
  claimedAt?: Date | null;
}

async function insertJob(db: Db, opts: InsertJobOpts): Promise<string> {
  const [job] = await db
    .insert(graphJobs)
    .values({
      repositoryId: opts.repositoryId,
      kind: opts.kind ?? "build",
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
      ...(opts.claimedAt !== undefined ? { claimedAt: opts.claimedAt } : {}),
    })
    .returning({ id: graphJobs.id });
  return job!.id;
}

async function getJob(db: Db, id: string): Promise<GraphJob> {
  const [row] = await db.select().from(graphJobs).where(eq(graphJobs.id, id));
  return row!;
}

/** Un istante ben oltre la soglia di staleness (orfano certo). */
function longAgo(): Date {
  return new Date(Date.now() - (GRAPH_STALE_MINUTES + 45) * 60 * 1000);
}

/** Attesa breve, per far scattare qualche tick del poller reale. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("pollGraphJobsOnce", () => {
  it("reclama un job build, lo esegue e lo chiude done", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId });

    const runGraphBuildFn = vi.fn<RunGraphBuildFn>(async () => true);
    const done = await pollGraphJobsOnce(makeDeps(db, { runGraphBuildFn }));

    expect(done).toBe(1);
    expect(runGraphBuildFn).toHaveBeenCalledTimes(1);
    // Il runner riceve il job RECLAMATO (già running).
    expect(runGraphBuildFn.mock.calls[0]![1]).toMatchObject({ id, status: "running" });
    const job = await getJob(db, id);
    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
  });

  it("esegue il job nella CATENA PER-PROGETTO del repository", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await seedRepository(db);
    await insertJob(db, { repositoryId });

    const seen: string[] = [];
    const inner = createProjectSerializer();
    const serializer: ProjectSerializer = {
      run: (key, task) => {
        seen.push(key);
        return inner.run(key, task);
      },
    };

    await pollGraphJobsOnce(makeDeps(db, { serializer, runGraphBuildFn: async () => true }));

    expect(seen).toEqual([projectId]);
  });

  it("build fallita (false): il job resta failed, il poller non lo chiude done", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId });

    // Contratto del runner: su fallimento chiude LUI il job (failGraphJob) e
    // torna false.
    const runGraphBuildFn = vi.fn(async (deps: GraphBuildDeps, job: GraphJob) => {
      await failGraphJob(deps.db, job.id, "extract fallito");
      return false;
    });
    const done = await pollGraphJobsOnce(makeDeps(db, { runGraphBuildFn }));

    expect(done).toBe(0);
    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("extract fallito");
  });

  it("kind setup_pr: esegue il runner della PR di setup e chiude done", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId, kind: "setup_pr" });

    const runGraphBuildFn = vi.fn<RunGraphBuildFn>(async () => true);
    const runGraphSetupPrFn = vi.fn<RunGraphSetupPrFn>(async () => true);
    const done = await pollGraphJobsOnce(makeDeps(db, { runGraphBuildFn, runGraphSetupPrFn }));

    expect(done).toBe(1);
    expect(runGraphBuildFn).not.toHaveBeenCalled();
    expect(runGraphSetupPrFn).toHaveBeenCalledTimes(1);
    expect(runGraphSetupPrFn.mock.calls[0]![1]).toMatchObject({ id, kind: "setup_pr", status: "running" });
    const job = await getJob(db, id);
    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
  });

  it("PR di setup fallita (false): job failed, ma repo_graphs NON viene toccata", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    // Grafo pronto: un fallimento della PR non deve invalidarlo.
    await db.insert(repoGraphs).values({ repositoryId, status: "done" });
    const id = await insertJob(db, { repositoryId, kind: "setup_pr" });

    // Contratto del runner: su fallimento chiude LUI il job (solo il job).
    const runGraphSetupPrFn = vi.fn(async (deps: GraphSetupPrDeps, job: GraphJob) => {
      await failGraphJobOnly(deps.db, job.id, "apertura PR fallita");
      return false;
    });
    const done = await pollGraphJobsOnce(makeDeps(db, { runGraphSetupPrFn }));

    expect(done).toBe(0);
    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("apertura PR fallita");
    const [graph] = await db.select().from(repoGraphs).where(eq(repoGraphs.repositoryId, repositoryId));
    expect(graph?.status).toBe("done");
  });

  it("un'eccezione del runner fallisce SOLO quel job e il tick prosegue col successivo", async () => {
    const db = testDb.db;
    // Due repository: l'indice unico parziale ammette un solo job attivo per
    // (repository, kind).
    const first = await seedRepository(db);
    const second = await seedRepository(db);
    const boomId = await insertJob(db, { repositoryId: first.repositoryId });
    await settle(5); // ordine di claim deterministico (created_at crescente).
    const okId = await insertJob(db, { repositoryId: second.repositoryId });

    const runGraphBuildFn = vi.fn(async (_deps: GraphBuildDeps, job: GraphJob) => {
      if (job.id === boomId) throw new Error("crash imprevisto del runner");
      return true;
    });
    const done = await pollGraphJobsOnce(makeDeps(db, { runGraphBuildFn }));

    expect(done).toBe(1);
    const boom = await getJob(db, boomId);
    expect(boom.status).toBe("failed");
    expect(boom.error).toContain("crash imprevisto del runner");
    expect((await getJob(db, okId)).status).toBe("done");
  });

  it("recupera gli orfani PRIMA di reclamare (running stantio → queued ed eseguito)", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, {
      repositoryId,
      status: "running",
      claimedAt: longAgo(),
      attempts: 0,
    });

    const runGraphBuildFn = vi.fn(async () => true);
    const done = await pollGraphJobsOnce(makeDeps(db, { runGraphBuildFn }));

    expect(done).toBe(1);
    const job = await getJob(db, id);
    expect(job.status).toBe("done");
    // Il recovery ha consumato un tentativo prima del ri-claim.
    expect(job.attempts).toBe(1);
  });

  it("recupero degli orfani a tentativi esauriti: failed senza eseguire nulla", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, {
      repositoryId,
      status: "running",
      claimedAt: longAgo(),
      attempts: MAX_GRAPH_ATTEMPTS - 1,
    });

    const runGraphBuildFn = vi.fn(async () => true);
    const done = await pollGraphJobsOnce(makeDeps(db, { runGraphBuildFn }));

    expect(done).toBe(0);
    expect(runGraphBuildFn).not.toHaveBeenCalled();
    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/segni di vita/);
  });
});

describe("startGraphPoller", () => {
  it("intervalSeconds ≤ 0: non avvia nulla", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId });

    const runGraphBuildFn = vi.fn(async () => true);
    const controller = new AbortController();
    const stop = startGraphPoller({
      ...makeDeps(db, { runGraphBuildFn }),
      intervalSeconds: 0,
      signal: controller.signal,
    });
    await settle(60);
    stop();

    expect(runGraphBuildFn).not.toHaveBeenCalled();
    expect((await getJob(db, id)).status).toBe("queued");
  });

  it("non sovrappone i tick: un giro lento non ne fa partire un secondo", async () => {
    const db = testDb.db;
    const first = await seedRepository(db);
    const second = await seedRepository(db);
    await insertJob(db, { repositoryId: first.repositoryId });
    await settle(5);
    await insertJob(db, { repositoryId: second.repositoryId });

    // Il primo job resta appeso al gate: se un secondo tick partisse,
    // reclamerebbe il secondo job e il runner risulterebbe chiamato due volte.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runGraphBuildFn = vi.fn(async () => {
      await gate;
      return true;
    });

    const controller = new AbortController();
    const stop = startGraphPoller({
      ...makeDeps(db, { runGraphBuildFn }),
      // 20 ms: nella finestra sotto scattano molti tick.
      intervalSeconds: 0.02,
      signal: controller.signal,
    });
    await settle(200);
    expect(runGraphBuildFn).toHaveBeenCalledTimes(1);

    release();
    stop();
    controller.abort();
  });

  it("si ferma sull'AbortSignal (nessun tick dopo l'abort)", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    await insertJob(db, { repositoryId });

    const runGraphBuildFn = vi.fn(async () => true);
    const controller = new AbortController();
    startGraphPoller({
      ...makeDeps(db, { runGraphBuildFn }),
      intervalSeconds: 0.02,
      signal: controller.signal,
    });
    controller.abort();
    await settle(120);

    expect(runGraphBuildFn).not.toHaveBeenCalled();
  });
});
