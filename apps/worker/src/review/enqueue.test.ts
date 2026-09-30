import { encrypt, gitAccounts, instanceSettings, prReviewJobs, projects, repositories } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enqueuePrReviewNow } from "./enqueue.js";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  // pr_review_jobs casca da repositories, che casca da projects.
  await testDb.db.delete(projects);
  await testDb.db.delete(gitAccounts);
  await testDb.db.update(instanceSettings).set({ prReviewEnabled: false }).where(eq(instanceSettings.id, 1));
});

afterAll(async () => {
  await testDb.stop();
});

async function createRepository(): Promise<string> {
  const [account] = await testDb.db
    .insert(gitAccounts)
    .values({
      name: `Account ${randomUUID()}`,
      provider: "github",
      encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), randomBytes(32)),
    })
    .returning();
  const [project] = await testDb.db
    .insert(projects)
    .values({ name: "P", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() })
    .returning();
  const [repository] = await testDb.db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: "R",
      slug: `r-${randomUUID()}`,
      provider: "github",
      gitAccountId: account!.id,
      repoUrl: "https://example.com/owner/repo",
      defaultBranch: "main",
    })
    .returning();
  return repository!.id;
}

function reviewInput(repositoryId: string, headSha = "a".repeat(40), prNumber = 12) {
  return {
    repositoryId,
    prNumber,
    prUrl: `https://github.com/acme/repo/pull/${prNumber}`,
    prTitle: "fix: sum (#7)",
    prBody: "report",
    sourceBranch: "stubwise/ticket-7",
    targetBranch: "main",
    headSha,
  };
}

async function enableReview(): Promise<void> {
  await testDb.db.update(instanceSettings).set({ prReviewEnabled: true }).where(eq(instanceSettings.id, 1));
}

describe("enqueuePrReviewNow", () => {
  it("review spenta d'istanza: non accoda niente", async () => {
    const repositoryId = await createRepository();
    expect(await enqueuePrReviewNow(testDb.db, reviewInput(repositoryId))).toBe(false);
    expect(await testDb.db.select().from(prReviewJobs)).toHaveLength(0);
  });

  it("review accesa: accoda con not_before già scaduto per il poller", async () => {
    const repositoryId = await createRepository();
    await enableReview();

    expect(await enqueuePrReviewNow(testDb.db, reviewInput(repositoryId))).toBe(true);

    // Lo stesso predicato del claim del poller (`not_before <= now()`).
    const due = await testDb.db
      .select()
      .from(prReviewJobs)
      .where(sql`${prReviewJobs.notBefore} <= now()`);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ prNumber: 12, headSha: "a".repeat(40), sourceBranch: "stubwise/ticket-7" });
  });

  it("si fonde col pending del webhook: una riga sola, head nostra e finestra anticipata", async () => {
    const repositoryId = await createRepository();
    await enableReview();
    // Il webhook è arrivato prima: head abbreviata (Bitbucket) e debounce nel futuro.
    await testDb.db.insert(prReviewJobs).values({
      ...reviewInput(repositoryId, "b".repeat(12)),
      notBefore: new Date(Date.now() + 10 * 60_000),
    });

    expect(await enqueuePrReviewNow(testDb.db, reviewInput(repositoryId, "c".repeat(40)))).toBe(true);

    const rows = await testDb.db.select().from(prReviewJobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.headSha).toBe("c".repeat(40));
    const due = await testDb.db.select().from(prReviewJobs).where(sql`${prReviewJobs.notBefore} <= now()`);
    expect(due).toHaveLength(1);
  });

  it("non tocca il debounce di un'altra PR dello stesso repository", async () => {
    const repositoryId = await createRepository();
    await enableReview();
    const later = new Date(Date.now() + 10 * 60_000);
    await testDb.db.insert(prReviewJobs).values({
      ...reviewInput(repositoryId, "d".repeat(40), 13),
      notBefore: later,
    });

    await enqueuePrReviewNow(testDb.db, reviewInput(repositoryId, "e".repeat(40), 12));

    const [other] = await testDb.db
      .select()
      .from(prReviewJobs)
      .where(and(eq(prReviewJobs.repositoryId, repositoryId), eq(prReviewJobs.prNumber, 13)));
    expect(other!.headSha).toBe("d".repeat(40));
    expect(other!.notBefore.getTime()).toBe(later.getTime());
  });

  it("best-effort: un errore del database non lancia, torna false", async () => {
    await enableReview();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Repository inesistente: la FK fa fallire l'insert.
      await expect(enqueuePrReviewNow(testDb.db, reviewInput(randomUUID()))).resolves.toBe(false);
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
    expect(await testDb.db.select().from(prReviewJobs)).toHaveLength(0);
  });
});
