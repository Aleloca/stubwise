import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import {
  aiJobs,
  encrypt,
  gitAccounts,
  prCorrections,
  prReviews,
  repositories,
  ticketRepositories,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { GitHubProvider, type PullRequestInfo } from "@stubwise/git";
import { addMember, seedUsers, type SeededUsers } from "../test/fixtures.js";
import { enqueueCorrection } from "@stubwise/notifications";
import { PROJECT_PERMISSIONS } from "@stubwise/shared";

/**
 * ADOZIONE di una PR aperta da altri (6 ott 2026, piano
 * `docs/plans/2026-10-06-adopt-external-pr.md`).
 *
 * I test che contano di più sono NEGATIVI e asseriscono sulle RIGHE, non solo
 * sulla risposta: un operatore non adotta né rilascia (403 E niente scritto),
 * e una PR da fork, da fork non verificabile o sul branch base non viene mai
 * adottata — perché adottarla vorrebbe dire pushare dove Stubwise non deve.
 */

const ENCRYPTION_KEY = randomBytes(32);
const MAIN_TOKEN = "tok-principale";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
  });
  users = await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

let ticketSeq = 100;

interface ReviewTicket {
  ticketId: string;
  repositoryId: string;
  reviewId: string;
}

/** Un ticket `review` con la sua review completata della PR #7 (branch `feature/login`). */
async function seedReviewTicket(
  opts: {
    type?: "review" | "bug";
    status?: "open" | "done";
    fromFork?: boolean | null;
    verdict?: "approve" | "request_changes";
  } = {},
): Promise<ReviewTicket> {
  const { projectId, repositoryId } = await seedRepository(testDb.db);
  // L'operatore ci lavora come dopo la conversione: Legacy Member, senza `prs.adopt`.
  await addMember(app, projectId, users.memberId);
  const [repo] = await testDb.db
    .select({ accountId: repositories.gitAccountId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  await testDb.db
    .update(gitAccounts)
    .set({ encryptedCredentials: encrypt(JSON.stringify({ token: MAIN_TOKEN }), ENCRYPTION_KEY) })
    .where(eq(gitAccounts.id, repo!.accountId));
  ticketSeq++;
  const [ticket] = await testDb.db
    .insert(tickets)
    .values({
      projectId,
      number: ticketSeq,
      title: "PR Review: Add login (#7)",
      body: "Review automatica",
      type: opts.type ?? "review",
      priority: "medium",
      status: opts.status ?? "open",
      source: "webhook",
    })
    .returning({ id: tickets.id });
  const [review] = await testDb.db
    .insert(prReviews)
    .values({
      repositoryId,
      prNumber: 7,
      prUrl: "https://github.com/acme/repo/pull/7",
      prTitle: "Add login",
      headSha: "a".repeat(40),
      ticketId: ticket!.id,
      status: "completed",
      verdict: opts.verdict ?? "request_changes",
      summary: "- manca la validazione",
      startedAt: new Date(),
      sourceBranch: "feature/login",
      targetBranch: "main",
      fromFork: opts.fromFork ?? false,
    })
    .returning({ id: prReviews.id });
  return { ticketId: ticket!.id, repositoryId, reviewId: review!.id };
}

function prInfo(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    state: "open",
    sourceBranch: "feature/login",
    targetBranch: "main",
    headSha: "a".repeat(40),
    fromFork: false,
    ...overrides,
  };
}

function mockProvider(info: PullRequestInfo | Error = prInfo()) {
  const getInfo = vi.spyOn(GitHubProvider.prototype, "getPullRequestInfo");
  if (info instanceof Error) getInfo.mockRejectedValue(info);
  else getInfo.mockResolvedValue(info);
  const comment = vi.spyOn(GitHubProvider.prototype, "createPrComment").mockResolvedValue(undefined);
  return { getInfo, comment };
}

/**
 * Una PR adottata da una PERSONA (l'admin), com'era scritta dall'adozione
 * finché c'era la sua rotta (tolta con R2): la riga col branch, il «Solo
 * analisi» tolto e la prima correzione accodata. Le PR già adottate restano, e
 * quello che segue (correzioni, branch protetto, la vista) vale ancora.
 */
async function adopt(t: ReviewTicket): Promise<void> {
  const adoption = {
    branch: "feature/login",
    prUrl: "https://github.com/acme/repo/pull/7",
    prNumber: 7,
    prState: "open" as const,
    adoptedAt: new Date(),
    adoptedByUserId: users.adminId,
    adoptionReleasedAt: null,
    adoptionReleasedByUserId: null,
  };
  await testDb.db
    .insert(ticketRepositories)
    .values({ ticketId: t.ticketId, repositoryId: t.repositoryId, ...adoption })
    .onConflictDoUpdate({ target: [ticketRepositories.ticketId, ticketRepositories.repositoryId], set: adoption });
  await testDb.db
    .update(prReviews)
    .set({ analysisOnly: false, analysisOnlyBy: null, analysisOnlyAt: null })
    .where(eq(prReviews.ticketId, t.ticketId));
  const enqueued = await enqueueCorrection(testDb.db, {
    ticketId: t.ticketId,
    repositoryId: t.repositoryId,
    prNumber: 7,
    trigger: "stubwise",
    requestedByUserId: users.adminId,
    actorPermissions: new Set(PROJECT_PERMISSIONS),
    reviewId: t.reviewId,
  });
  expect(enqueued.ok).toBe(true);
}

async function rowOf(t: ReviewTicket) {
  const [row] = await testDb.db
    .select()
    .from(ticketRepositories)
    .where(and(eq(ticketRepositories.ticketId, t.ticketId), eq(ticketRepositories.repositoryId, t.repositoryId)));
  return row;
}

async function correctionsOf(t: ReviewTicket) {
  return testDb.db.select().from(prCorrections).where(eq(prCorrections.ticketId, t.ticketId));
}

async function jobsOf(t: ReviewTicket) {
  return testDb.db.select().from(aiJobs).where(eq(aiJobs.ticketId, t.ticketId));
}

async function detail(t: ReviewTicket, cookie: string) {
  const res = await app.inject({ method: "GET", url: `/api/tickets/${t.ticketId}`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    prAdoption: Record<string, unknown> | null;
    repositories: { branch: string; cycle: Record<string, unknown> | null }[];
  };
}

const codeOf = (res: { json: () => unknown }) => (res.json() as { code: string }).code;

describe("GET /api/tickets/:id — prAdoption, derivato col ruolo di chi guarda", () => {
  it("stessi dati, due ruoli: canManage vero solo per il maintainer", async () => {
    const t = await seedReviewTicket();
    expect((await detail(t, users.adminCookie)).prAdoption).toMatchObject({
      state: "available",
      branch: "feature/login",
      prNumber: 7,
      canManage: true,
    });
    expect((await detail(t, users.memberCookie)).prAdoption).toMatchObject({ canManage: false });
  });

  it("fork noto dal webhook: spento col motivo", async () => {
    const t = await seedReviewTicket({ fromFork: true });
    expect((await detail(t, users.adminCookie)).prAdoption).toMatchObject({
      state: "unavailable",
      unavailableReason: "fork",
    });
  });

  it("branch noto e protetto sulla repository: spento col motivo, prima del click", async () => {
    const t = await seedReviewTicket();
    await testDb.db
      .update(repositories)
      .set({ protectedBranches: ["feature/*"] })
      .where(eq(repositories.id, t.repositoryId));
    expect((await detail(t, users.adminCookie)).prAdoption).toMatchObject({
      state: "unavailable",
      unavailableReason: "protected_branch",
      branch: "feature/login",
    });
  });

  it("fork non noto (review vecchia): disponibile, l'adozione verificherà", async () => {
    const t = await seedReviewTicket({ fromFork: null });
    expect((await detail(t, users.adminCookie)).prAdoption).toMatchObject({ state: "available" });
  });

  it("ticket review chiuso: spento, PR chiusa", async () => {
    const t = await seedReviewTicket({ status: "done" });
    expect((await detail(t, users.adminCookie)).prAdoption).toMatchObject({
      state: "unavailable",
      unavailableReason: "pr_closed",
    });
  });

  it("PR adottata poi chiusa o mergiata: mai «adopted» (niente «Smetti» premibile), spenta come PR chiusa", async () => {
    const t = await seedReviewTicket();
    mockProvider();
    await adopt(t);
    // Anche se l'adozione non fosse stata rilasciata (difesa): la PR non è più aperta.
    await testDb.db
      .update(ticketRepositories)
      .set({ prState: "merged" })
      .where(eq(ticketRepositories.ticketId, t.ticketId));
    expect((await detail(t, users.adminCookie)).prAdoption).toMatchObject({
      state: "unavailable",
      unavailableReason: "pr_closed",
      adoptedBy: null,
    });
  });

  it("un ticket che non è review: null", async () => {
    const t = await seedReviewTicket({ type: "bug" });
    expect((await detail(t, users.adminCookie)).prAdoption).toBeNull();
  });
});

describe("POST /api/tickets/:id/run-ai su un ticket review", () => {
  it("niente fix: 409 review_ticket_not_runnable e nessun job (il «Rilancia» di un job.failed)", async () => {
    const t = await seedReviewTicket();
    mockProvider();
    await adopt(t);
    // La correzione è finita male: il suo job è terminale.
    await testDb.db.update(aiJobs).set({ status: "failed" }).where(eq(aiJobs.ticketId, t.ticketId));
    await testDb.db.update(prCorrections).set({ status: "done" }).where(eq(prCorrections.ticketId, t.ticketId));

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${t.ticketId}/run-ai`,
      headers: { cookie: users.adminCookie },
    });

    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("review_ticket_not_runnable");
    expect(await jobsOf(t)).toHaveLength(1);
  });

  it("la ripresa di una correzione ferma su una PR ADOTTATA: un member riceve 403 e niente cambia", async () => {
    const t = await seedReviewTicket();
    mockProvider();
    await adopt(t);
    await testDb.db
      .update(aiJobs)
      .set({ status: "held", heldReason: "limit" })
      .where(eq(aiJobs.ticketId, t.ticketId));
    const [job] = await jobsOf(t);

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${t.ticketId}/run-ai`,
      headers: { cookie: users.memberCookie },
      payload: { resumeCorrectionJobId: job!.id },
    });

    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe("needs_maintainer");
    expect((await jobsOf(t))[0]!.status).toBe("held");
    // E il ciclo non glielo offre.
    const d = await detail(t, users.memberCookie);
    expect(d.repositories[0]!.cycle).toMatchObject({ canResume: false, canRequestCorrection: false });
  });

  it("la ripresa della correzione FERMA invece passa", async () => {
    const t = await seedReviewTicket();
    mockProvider();
    await adopt(t);
    await testDb.db
      .update(aiJobs)
      .set({ status: "held", heldReason: "budget" })
      .where(eq(aiJobs.ticketId, t.ticketId));
    const [job] = await jobsOf(t);

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${t.ticketId}/run-ai`,
      headers: { cookie: users.adminCookie },
      payload: { resumeCorrectionJobId: job!.id },
    });

    expect(res.statusCode).toBe(202);
    expect((await jobsOf(t))[0]!.status).toBe("queued");
  });
});

describe("PR adottata col branch diventato PROTETTO: rifiuto subito, niente scritto (7 ott 2026)", () => {
  async function protectAdoptedBranch(t: ReviewTicket) {
    const row = await rowOf(t);
    await testDb.db
      .update(repositories)
      .set({ protectedBranches: [row!.branch!] })
      .where(eq(repositories.id, t.repositoryId));
  }

  it("«Chiedi modifiche» di un admin: 409 adopted_branch_protected, nessuna riga nuova; il ciclo lo dice", async () => {
    const t = await seedReviewTicket();
    mockProvider();
    await adopt(t);
    await testDb.db.update(aiJobs).set({ status: "failed" }).where(eq(aiJobs.ticketId, t.ticketId));
    await testDb.db.update(prCorrections).set({ status: "done" }).where(eq(prCorrections.ticketId, t.ticketId));
    await protectAdoptedBranch(t);

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${t.ticketId}/repositories/${t.repositoryId}/corrections`,
      headers: { cookie: users.adminCookie },
    });

    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("adopted_branch_protected");
    expect(await correctionsOf(t)).toHaveLength(1);
    expect(await jobsOf(t)).toHaveLength(1);
    const d = await detail(t, users.adminCookie);
    expect(d.repositories[0]!.cycle).toMatchObject({
      canRequestCorrection: false,
      blockedReason: "adopted_branch_protected",
    });
  });

  it("senza protezione lo stesso click passa (verso opposto)", async () => {
    const t = await seedReviewTicket();
    mockProvider();
    await adopt(t);
    await testDb.db.update(aiJobs).set({ status: "failed" }).where(eq(aiJobs.ticketId, t.ticketId));
    await testDb.db.update(prCorrections).set({ status: "done" }).where(eq(prCorrections.ticketId, t.ticketId));

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${t.ticketId}/repositories/${t.repositoryId}/corrections`,
      headers: { cookie: users.adminCookie },
    });
    expect(res.statusCode).toBe(202);
    const d = await detail(t, users.adminCookie);
    expect(d.repositories[0]!.cycle).toMatchObject({ blockedReason: null });
  });

  it("ripresa di una correzione ferma: 409 adopted_branch_protected anche per un admin, il job resta held", async () => {
    const t = await seedReviewTicket();
    mockProvider();
    await adopt(t);
    await testDb.db
      .update(aiJobs)
      .set({ status: "held", heldReason: "limit" })
      .where(eq(aiJobs.ticketId, t.ticketId));
    await protectAdoptedBranch(t);
    const [job] = await jobsOf(t);

    const res = await app.inject({
      method: "POST",
      url: `/api/tickets/${t.ticketId}/run-ai`,
      headers: { cookie: users.adminCookie },
      payload: { resumeCorrectionJobId: job!.id },
    });

    expect(res.statusCode).toBe(409);
    expect(codeOf(res)).toBe("adopted_branch_protected");
    expect((await jobsOf(t))[0]!.status).toBe("held");
    const d = await detail(t, users.adminCookie);
    expect(d.repositories[0]!.cycle).toMatchObject({ canResume: false });
  });
});
