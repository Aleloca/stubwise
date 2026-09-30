import {
  encrypt,
  gitAccounts,
  prReviewJobs,
  prReviews,
  projects,
  repositories,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectSerializer } from "../handler.js";
import { pollPrReviewsOnce, requeueWaitingReviews, type PollPrReviewsDeps } from "./poller.js";
import type { PrReviewJobRow } from "./run-review.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  // pr_review_jobs e pr_reviews cascano da repositories (che casca da projects).
  await testDb.db.delete(projects);
  await testDb.db.delete(gitAccounts);
});

afterAll(async () => {
  await testDb.stop();
});

/** Progetto + repository con credenziali git cifrate (pattern run-review.test). */
async function createRepository(db: Db): Promise<{ projectId: string; repositoryId: string }> {
  const [account] = await db
    .insert(gitAccounts)
    .values({
      name: `Account poller ${randomUUID()}`,
      provider: "github",
      encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
    })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      name: "Progetto poller",
      slug: `poller-${randomUUID()}`,
      ingestionKey: randomUUID(),
    })
    .returning();
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: "Repo poller",
      slug: `repo-${randomUUID()}`,
      provider: "github",
      gitAccountId: account!.id,
      repoUrl: "https://example.com/owner/repo",
      defaultBranch: "main",
    })
    .returning();
  return { projectId: project!.id, repositoryId: repository!.id };
}

/** Inserisce un pending in pr_review_jobs (notBefore relativo a now). */
async function insertJob(
  db: Db,
  repositoryId: string,
  prNumber: number,
  notBeforeOffsetMs: number,
): Promise<void> {
  await db.insert(prReviewJobs).values({
    repositoryId,
    prNumber,
    prUrl: `https://example.com/owner/repo/pull/${prNumber}`,
    prTitle: `PR ${prNumber}`,
    prBody: `Corpo della PR ${prNumber}.`,
    sourceBranch: `feature/pr-${prNumber}`,
    targetBranch: "main",
    headSha: "a".repeat(40),
    notBefore: new Date(Date.now() + notBeforeOffsetMs),
  });
}

/** Serializer fake: registra i projectId ed esegue subito il task. */
function makeSerializer(): { serializer: ProjectSerializer; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    serializer: {
      run: async <T,>(projectId: string, task: () => Promise<T>): Promise<T> => {
        calls.push(projectId);
        return task();
      },
    },
  };
}

/** Un metodo che il poller non deve mai chiamare. */
function unused(): never {
  throw new Error("metodo mai chiamato dal poller");
}

function makeDeps(
  serializer: ProjectSerializer,
  runPrReviewFn: PollPrReviewsDeps["runPrReviewFn"],
  staleMinutes = 15,
): PollPrReviewsDeps {
  return {
    db: testDb.db,
    // Mai toccati dal poller: la review vera è sostituita dallo spy. Doppi
    // completi, senza cast: un metodo chiamato per sbaglio lancia.
    mirrors: { withWorktreeAtSha: unused, getPrDiff: unused, resolveCommitSha: unused },
    runner: { run: unused },
    encryptionKey: ENCRYPTION_KEY,
    model: "sonnet",
    maxTurns: 50,
    agentTimeoutMs: 60_000,
    staleMinutes,
    serializer,
    ...(runPrReviewFn !== undefined ? { runPrReviewFn } : {}),
  };
}

describe("pollPrReviewsOnce", () => {
  it("reclama solo i job con notBefore scaduto e li esegue nel serializer del progetto", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await insertJob(testDb.db, repositoryId, 1, -60_000); // scaduto
    await insertJob(testDb.db, repositoryId, 2, 5 * 60_000); // futuro

    const seen: PrReviewJobRow[] = [];
    const seenReviewIds: string[] = [];
    const waitingDuringRun: { repositoryId: string; status: string; startedAt: Date | null }[] = [];
    const spy = vi.fn(async (_deps: unknown, job: PrReviewJobRow, reviewId: string) => {
      seen.push(job);
      seenReviewIds.push(reviewId);
      const [row] = await testDb.db.select().from(prReviews).where(eq(prReviews.id, reviewId));
      if (row) waitingDuringRun.push({ repositoryId: row.repositoryId, status: row.status, startedAt: row.startedAt });
    });
    const { serializer, calls } = makeSerializer();

    const claimed = await pollPrReviewsOnce(makeDeps(serializer, spy));
    expect(claimed).toBe(1);

    // Lo spy è stato chiamato una volta col job scaduto, campi completi.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual({
      repositoryId,
      prNumber: 1,
      prUrl: "https://example.com/owner/repo/pull/1",
      prTitle: "PR 1",
      prBody: "Corpo della PR 1.",
      sourceBranch: "feature/pr-1",
      targetBranch: "main",
      headSha: "a".repeat(40),
    });

    // Il terzo argomento è la riga pr_reviews IN ATTESA del repository.
    expect(seenReviewIds).toHaveLength(1);
    expect(waitingDuringRun).toEqual([{ repositoryId, status: "running", startedAt: null }]);

    // In tabella resta SOLO il futuro (il claim è un DELETE).
    const remaining = await testDb.db.select().from(prReviewJobs);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.prNumber).toBe(2);

    // Il serializer è stato usato col projectId del repository.
    expect(calls).toEqual([projectId]);
  });

  it("un job che lancia non blocca gli altri e non propaga", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await insertJob(testDb.db, repositoryId, 1, -60_000);
    await insertJob(testDb.db, repositoryId, 2, -60_000);

    const executed: number[] = [];
    const spy = vi.fn(async (_deps: unknown, job: PrReviewJobRow) => {
      if (executed.length === 0) {
        executed.push(job.prNumber);
        throw new Error("review esplosa");
      }
      executed.push(job.prNumber);
    });
    const { serializer } = makeSerializer();

    // Non propaga e reclama entrambi i job.
    await expect(pollPrReviewsOnce(makeDeps(serializer, spy))).resolves.toBe(2);
    // Il secondo job è stato comunque eseguito nonostante il primo lanci.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(executed).toHaveLength(2);
    expect(new Set(executed)).toEqual(new Set([1, 2]));
    // Nessun job rimasto: il claim li ha consumati entrambi.
    expect(await testDb.db.select().from(prReviewJobs)).toHaveLength(0);
  });

  it("repository sparito dopo il claim → job saltato senza errori", async () => {
    // NB: pr_review_jobs.repository_id è ON DELETE CASCADE: non si può
    // preparare in tabella un job orfano (sparirebbe col repo). Il ramo
    // "repository sparito" è una RACE fra claim e risoluzione del progetto: la
    // simuliamo con due job sullo stesso repo e uno spy che cancella il repo
    // alla prima esecuzione — il secondo job (già reclamato, in memoria) trova
    // il repo sparito e viene saltato senza errori.
    const { repositoryId } = await createRepository(testDb.db);
    await insertJob(testDb.db, repositoryId, 1, -60_000);
    await insertJob(testDb.db, repositoryId, 2, -60_000);

    const spy = vi.fn(async () => {
      await testDb.db.delete(repositories).where(eq(repositories.id, repositoryId));
    });
    const { serializer } = makeSerializer();

    // Entrambi reclamati, nessun errore propagato.
    await expect(pollPrReviewsOnce(makeDeps(serializer, spy))).resolves.toBe(2);
    // Solo il primo job arriva allo spy: il secondo è saltato (repo sparito).
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("recovery: righe pr_reviews running con heartbeat stantio → failed", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    const base = {
      repositoryId,
      prUrl: "https://example.com/owner/repo/pull/9",
      prTitle: "PR 9",
      headSha: "b".repeat(40),
      status: "running" as const,
    };
    // Heartbeat fermo da 30' (oltre staleMinutes=15) → orfana di un worker morto.
    const [stale] = await testDb.db
      .insert(prReviews)
      .values({
        ...base,
        prNumber: 9,
        lastActivityAt: new Date(Date.now() - 30 * 60_000),
        startedAt: new Date(Date.now() - 60 * 60_000),
      })
      .returning();
    // Heartbeat fresco → review viva, non va toccata.
    const [fresh] = await testDb.db
      .insert(prReviews)
      .values({ ...base, prNumber: 10, lastActivityAt: new Date(), startedAt: new Date(Date.now() - 60 * 60_000) })
      .returning();

    const spy = vi.fn(async () => {});
    const { serializer } = makeSerializer();
    await pollPrReviewsOnce(makeDeps(serializer, spy, 15));

    const [staleRow] = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, stale!.id));
    expect(staleRow?.status).toBe("failed");
    expect(staleRow?.error).toMatch(/stantio/);
    expect(staleRow?.finishedAt).not.toBeNull();

    const [freshRow] = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, fresh!.id));
    expect(freshRow?.status).toBe("running");
    expect(freshRow?.error).toBeNull();
  });
  it("claim: la riga in attesa nasce nella stessa transazione del DELETE", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await insertJob(testDb.db, repositoryId, 1, -60_000);
    let seenDuringRun: { status: string; startedAt: Date | null; inQueue: number } | null = null;
    const spy = vi.fn(async (_deps: unknown, _job: PrReviewJobRow, reviewId: string) => {
      const [row] = await testDb.db.select().from(prReviews).where(eq(prReviews.id, reviewId));
      seenDuringRun = {
        status: row!.status,
        startedAt: row!.startedAt,
        inQueue: (await testDb.db.select().from(prReviewJobs)).length,
      };
    });
    const { serializer } = makeSerializer();

    await pollPrReviewsOnce(makeDeps(serializer, spy));

    // Mentre aspetta (qui: mentre gira lo spy, che non la fa partire) la
    // review esiste già, e il job non è più in coda.
    expect(seenDuringRun).toEqual({ status: "running", startedAt: null, inQueue: 0 });
  });

  it("una riga mai partita non sopravvive al suo run (uscita silenziosa o errore)", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await insertJob(testDb.db, repositoryId, 1, -60_000);
    await insertJob(testDb.db, repositoryId, 2, -60_000);
    const spy = vi.fn(async (_deps: unknown, job: PrReviewJobRow) => {
      if (job.prNumber === 2) throw new Error("review esplosa prima della partenza");
      // prNumber 1: uscita silenziosa (toggle spento, PR chiusa…)
    });
    const { serializer } = makeSerializer();

    await pollPrReviewsOnce(makeDeps(serializer, spy));

    expect(await testDb.db.select().from(prReviews)).toHaveLength(0);
  });

  it("recovery: una review IN ATTESA oltre la soglia NON viene chiusa; una PARTITA e ferma sì", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    const base = {
      repositoryId,
      prUrl: "https://example.com/owner/repo/pull/9",
      prTitle: "PR 9",
      headSha: "b".repeat(40),
      status: "running" as const,
      // Entrambe ferme da 3 ore: ben oltre staleMinutes=15.
      lastActivityAt: new Date(Date.now() - 180 * 60_000),
    };
    // In attesa nel serializer dietro job di altri ticket: nessun heartbeat,
    // ed è giusto così.
    const [waiting] = await testDb.db.insert(prReviews).values({ ...base, prNumber: 9 }).returning();
    const [started] = await testDb.db
      .insert(prReviews)
      .values({ ...base, prNumber: 10, startedAt: new Date(Date.now() - 200 * 60_000) })
      .returning();
    const { serializer } = makeSerializer();

    await pollPrReviewsOnce(makeDeps(serializer, vi.fn(async () => {}), 15));

    const byId = async (id: string) =>
      (await testDb.db.select().from(prReviews).where(eq(prReviews.id, id)))[0]!;
    expect((await byId(waiting!.id)).status).toBe("running");
    expect((await byId(started!.id)).status).toBe("failed");
  });
});

describe("requeueWaitingReviews (avvio del worker)", () => {
  it("riga in attesa → torna in pr_review_jobs e sparisce: il ciclo resta «reviewing» dalla coda", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    const [waiting] = await testDb.db
      .insert(prReviews)
      .values({
        repositoryId,
        prNumber: 5,
        prUrl: "https://example.com/owner/repo/pull/5",
        prTitle: "PR 5",
        prBody: "Corpo della PR 5.",
        sourceBranch: "stubwise/ticket-5",
        targetBranch: "main",
        headSha: "d".repeat(40),
        status: "running",
      })
      .returning();
    // Una partita: non si tocca (la chiude il recovery, se ferma).
    await testDb.db.insert(prReviews).values({
      repositoryId,
      prNumber: 6,
      prUrl: "https://example.com/owner/repo/pull/6",
      prTitle: "PR 6",
      headSha: "e".repeat(40),
      status: "running",
      startedAt: new Date(),
    });

    await requeueWaitingReviews(testDb.db);

    const queued = await testDb.db.select().from(prReviewJobs);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      repositoryId,
      prNumber: 5,
      prBody: "Corpo della PR 5.",
      sourceBranch: "stubwise/ticket-5",
      targetBranch: "main",
      headSha: "d".repeat(40),
    });
    expect(queued[0]!.notBefore.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const left = await testDb.db.select().from(prReviews);
    expect(left.map((r) => r.prNumber)).toEqual([6]);
    expect(left.some((r) => r.id === waiting!.id)).toBe(false);
  });

  it("un push più nuovo già in coda vince: si sposta solo not_before", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await insertJob(testDb.db, repositoryId, 7, 5 * 60_000); // head "a…", in debounce
    await testDb.db.insert(prReviews).values({
      repositoryId,
      prNumber: 7,
      prUrl: "https://example.com/owner/repo/pull/7",
      prTitle: "PR 7",
      prBody: "",
      sourceBranch: "feature/pr-7",
      targetBranch: "main",
      headSha: "f".repeat(40), // la head VECCHIA della riga in attesa
      status: "running",
    });

    await requeueWaitingReviews(testDb.db);

    const [queued] = await testDb.db.select().from(prReviewJobs);
    expect(queued!.headSha).toBe("a".repeat(40));
    expect(queued!.notBefore.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await testDb.db.select().from(prReviews)).toHaveLength(0);
  });

  it("riga in attesa senza metadati (binario intermedio) → failed, non appesa", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    const [row] = await testDb.db
      .insert(prReviews)
      .values({
        repositoryId,
        prNumber: 8,
        prUrl: "https://example.com/owner/repo/pull/8",
        prTitle: "PR 8",
        headSha: "a".repeat(40),
        status: "running",
      })
      .returning();

    await requeueWaitingReviews(testDb.db);

    const [after] = await testDb.db.select().from(prReviews).where(eq(prReviews.id, row!.id));
    expect(after!.status).toBe("failed");
    expect(await testDb.db.select().from(prReviewJobs)).toHaveLength(0);
  });
});
