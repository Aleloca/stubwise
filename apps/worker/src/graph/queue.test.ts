import { graphJobs, projects, repoGraphs, type Db } from "@stubwise/db";
import {
  seedRepository,
  seedRepositoryInProject,
  startTestDb,
  type TestDb,
} from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  claimNextGraphJob,
  completeGraphJob,
  failGraphJob,
  GRAPH_ERROR_MAX_CHARS,
  GRAPH_STALE_MINUTES,
  MAX_GRAPH_ATTEMPTS,
  recoverStaleGraphJobs,
} from "./queue.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  // repositories → repo_graphs / graph_jobs cascano dal progetto.
  await testDb.db.delete(projects);
});

afterAll(async () => {
  await testDb.stop();
});

interface InsertJobOpts {
  repositoryId: string;
  kind?: "build" | "setup_pr";
  status?: "queued" | "running" | "done" | "failed";
  attempts?: number;
  notBefore?: Date | null;
  claimedAt?: Date | null;
  force?: boolean;
  updatedAt?: Date;
}

async function insertJob(db: Db, opts: InsertJobOpts): Promise<string> {
  const [job] = await db
    .insert(graphJobs)
    .values({
      repositoryId: opts.repositoryId,
      kind: opts.kind ?? "build",
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
      ...(opts.notBefore !== undefined ? { notBefore: opts.notBefore } : {}),
      ...(opts.claimedAt !== undefined ? { claimedAt: opts.claimedAt } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.updatedAt !== undefined ? { updatedAt: opts.updatedAt } : {}),
    })
    .returning({ id: graphJobs.id });
  return job!.id;
}

async function getJob(db: Db, id: string): Promise<typeof graphJobs.$inferSelect> {
  const [row] = await db.select().from(graphJobs).where(eq(graphJobs.id, id));
  return row!;
}

async function getGraph(
  db: Db,
  repositoryId: string,
): Promise<typeof repoGraphs.$inferSelect | undefined> {
  const [row] = await db.select().from(repoGraphs).where(eq(repoGraphs.repositoryId, repositoryId));
  return row;
}

/** Un istante ben oltre la soglia di staleness (orfano certo). */
function longAgo(): Date {
  return new Date(Date.now() - (GRAPH_STALE_MINUTES + 45) * 60 * 1000);
}

describe("claimNextGraphJob", () => {
  it("marca running e valorizza claimedAt e updatedAt", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    const id = await insertJob(db, { repositoryId, updatedAt: stale });

    const claimed = await claimNextGraphJob(db);
    expect(claimed?.id).toBe(id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.claimedAt).not.toBeNull();
    // updated_at NON è mantenuto da trigger: il claim lo deve valorizzare a mano.
    expect(claimed!.updatedAt.getTime()).toBeGreaterThan(stale.getTime());
    // Gli attempts si incrementano nel recovery degli orfani, non al claim.
    expect(claimed?.attempts).toBe(0);
  });

  it("è FIFO su created_at e restituisce null a coda vuota", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await seedRepository(db);
    const first = await insertJob(db, { repositoryId });
    // Il secondo job ha created_at più recente (default now()): il claim prende prima il primo.
    await new Promise((r) => setTimeout(r, 5));
    const otherRepoId = await seedRepositoryInProject(db, projectId);
    await insertJob(db, { repositoryId: otherRepoId });

    const a = await claimNextGraphJob(db);
    expect(a?.id).toBe(first);
    const b = await claimNextGraphJob(db);
    expect(b?.id).not.toBe(first);
    expect(await claimNextGraphJob(db)).toBeNull();
  });

  it("NON reclama un job con notBefore nel futuro (debounce)", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, {
      repositoryId,
      notBefore: new Date(Date.now() + 60 * 60 * 1000),
    });

    expect(await claimNextGraphJob(db)).toBeNull();
    expect((await getJob(db, id)).status).toBe("queued");
  });

  it("reclama un job con notBefore già scaduto", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId, notBefore: new Date(Date.now() - 1000) });

    const claimed = await claimNextGraphJob(db);
    expect(claimed?.id).toBe(id);
  });

  it("salta il job in debounce e prende quello scaduto anche se più recente", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await seedRepository(db);
    await insertJob(db, { repositoryId, notBefore: new Date(Date.now() + 60 * 60 * 1000) });
    await new Promise((r) => setTimeout(r, 5));
    const otherRepoId = await seedRepositoryInProject(db, projectId);
    const ready = await insertJob(db, { repositoryId: otherRepoId });

    const claimed = await claimNextGraphJob(db);
    expect(claimed?.id).toBe(ready);
  });

  it("due claim concorrenti su due job prendono righe diverse (SKIP LOCKED)", async () => {
    const db = testDb.db;
    const { projectId, repositoryId } = await seedRepository(db);
    await insertJob(db, { repositoryId });
    const otherRepoId = await seedRepositoryInProject(db, projectId);
    await insertJob(db, { repositoryId: otherRepoId });

    const [a, b] = await Promise.all([claimNextGraphJob(db), claimNextGraphJob(db)]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });

  it("due claim concorrenti su un solo job: uno lo prende, l'altro null", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    await insertJob(db, { repositoryId });

    const results = await Promise.all([claimNextGraphJob(db), claimNextGraphJob(db)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });
});

describe("recoverStaleGraphJobs", () => {
  it("riaccoda l'orfano con tentativi residui, incrementa attempts e azzera claimedAt", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, {
      repositoryId,
      status: "running",
      claimedAt: longAgo(),
      updatedAt: longAgo(),
    });

    await recoverStaleGraphJobs(db, GRAPH_STALE_MINUTES, MAX_GRAPH_ATTEMPTS);

    const job = await getJob(db, id);
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(1);
    expect(job.claimedAt).toBeNull();
    expect(job.updatedAt.getTime()).toBeGreaterThan(longAgo().getTime());
    // Un riaccodamento non è un fallimento: nessuna riga di stato del grafo.
    expect(await getGraph(db, repositoryId)).toBeUndefined();
  });

  it("NON tocca un running reclamato di recente", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId, status: "running", claimedAt: new Date() });

    await recoverStaleGraphJobs(db, GRAPH_STALE_MINUTES, MAX_GRAPH_ATTEMPTS);

    expect((await getJob(db, id)).status).toBe("running");
  });

  it("all'ultimo tentativo fallisce il job e porta repo_graphs a failed", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, {
      repositoryId,
      status: "running",
      attempts: MAX_GRAPH_ATTEMPTS - 1,
      claimedAt: longAgo(),
    });

    await recoverStaleGraphJobs(db, GRAPH_STALE_MINUTES, MAX_GRAPH_ATTEMPTS);

    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(MAX_GRAPH_ATTEMPTS);
    expect(job.error).toBeTruthy();
    // La riga di stato del grafo non esisteva: il recovery la crea (upsert).
    const graph = await getGraph(db, repositoryId);
    expect(graph?.status).toBe("failed");
    expect(graph?.error).toBe(job.error);
  });

  it("aggiorna la riga repo_graphs già esistente invece di duplicarla", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await db
      .insert(repoGraphs)
      .values({ repositoryId, status: "running", commitSha: "a".repeat(40), updatedAt: old });
    const id = await insertJob(db, {
      repositoryId,
      status: "running",
      attempts: MAX_GRAPH_ATTEMPTS - 1,
      claimedAt: longAgo(),
    });

    await recoverStaleGraphJobs(db, GRAPH_STALE_MINUTES, MAX_GRAPH_ATTEMPTS);

    expect((await getJob(db, id)).status).toBe("failed");
    const rows = await db.select().from(repoGraphs).where(eq(repoGraphs.repositoryId, repositoryId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.updatedAt.getTime()).toBeGreaterThan(old.getTime());
    // I dati dell'ultima build restano leggibili accanto all'errore.
    expect(rows[0]!.commitSha).toBe("a".repeat(40));
  });

  it("percorre tutti i tentativi prima di fallire definitivamente", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId, status: "running", claimedAt: longAgo() });

    for (let i = 1; i < MAX_GRAPH_ATTEMPTS; i++) {
      await recoverStaleGraphJobs(db, GRAPH_STALE_MINUTES, MAX_GRAPH_ATTEMPTS);
      const requeued = await getJob(db, id);
      expect(requeued.status).toBe("queued");
      expect(requeued.attempts).toBe(i);
      // Reclamato di nuovo e di nuovo orfano.
      await claimNextGraphJob(db);
      await db.update(graphJobs).set({ claimedAt: longAgo() }).where(eq(graphJobs.id, id));
    }

    await recoverStaleGraphJobs(db, GRAPH_STALE_MINUTES, MAX_GRAPH_ATTEMPTS);
    const failed = await getJob(db, id);
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(MAX_GRAPH_ATTEMPTS);
    expect((await getGraph(db, repositoryId))?.status).toBe("failed");
  });
});

describe("completeGraphJob", () => {
  it("chiude il job come done, azzera l'errore e aggiorna updatedAt", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId, updatedAt: new Date(Date.now() - 60_000) });
    const before = await getJob(db, id);
    await claimNextGraphJob(db);

    await completeGraphJob(db, id);

    const job = await getJob(db, id);
    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
    expect(job.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    // Lo stato del grafo lo scrive il runner della build, non la coda.
    expect(await getGraph(db, repositoryId)).toBeUndefined();
  });

  it("non tocca un job che non è più running (ownership persa)", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId, status: "queued" });

    await completeGraphJob(db, id);

    expect((await getJob(db, id)).status).toBe("queued");
  });
});

describe("failGraphJob", () => {
  it("fallisce il job e porta repo_graphs a failed con lo stesso errore", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId });
    await claimNextGraphJob(db);

    await failGraphJob(db, id, "graphify extract exit 1");

    const job = await getJob(db, id);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("graphify extract exit 1");
    const graph = await getGraph(db, repositoryId);
    expect(graph?.status).toBe("failed");
    expect(graph?.error).toBe("graphify extract exit 1");
  });

  it("tronca un errore troppo lungo", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId });
    await claimNextGraphJob(db);

    await failGraphJob(db, id, "x".repeat(GRAPH_ERROR_MAX_CHARS * 2));

    const job = await getJob(db, id);
    expect(job.error!.length).toBeLessThanOrEqual(GRAPH_ERROR_MAX_CHARS + 40);
    expect(job.error!.startsWith("x".repeat(100))).toBe(true);
    expect((await getGraph(db, repositoryId))?.error).toBe(job.error);
  });

  it("non tocca un job che non è più running (ownership persa)", async () => {
    const db = testDb.db;
    const { repositoryId } = await seedRepository(db);
    const id = await insertJob(db, { repositoryId, status: "queued" });

    await failGraphJob(db, id, "boom");

    expect((await getJob(db, id)).status).toBe("queued");
    // Nessuna scrittura collaterale sullo stato del grafo.
    expect(await getGraph(db, repositoryId)).toBeUndefined();
  });
});
