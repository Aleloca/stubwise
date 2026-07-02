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
import type { AgentRunner } from "../agent/runner.js";
import type { MirrorManager } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import { pollPrReviewsOnce, type PollPrReviewsDeps } from "./poller.js";
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

function makeDeps(
  serializer: ProjectSerializer,
  runPrReviewFn: PollPrReviewsDeps["runPrReviewFn"],
  staleMinutes = 15,
): PollPrReviewsDeps {
  return {
    db: testDb.db,
    // Mai toccati dal poller: la review vera è sostituita dallo spy.
    mirrors: {} as unknown as Pick<MirrorManager, "withWorktreeAtSha" | "getPrDiff">,
    runner: {} as unknown as AgentRunner,
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
    const spy = vi.fn(async (_deps: unknown, job: PrReviewJobRow) => {
      seen.push(job);
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
      .values({ ...base, prNumber: 9, lastActivityAt: new Date(Date.now() - 30 * 60_000) })
      .returning();
    // Heartbeat fresco → review viva, non va toccata.
    const [fresh] = await testDb.db
      .insert(prReviews)
      .values({ ...base, prNumber: 10, lastActivityAt: new Date() })
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
});
