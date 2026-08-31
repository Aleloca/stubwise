import {
  agentRuns,
  aiProviders,
  comments,
  encrypt,
  gitAccounts,
  instanceSettings,
  prReviewJobs,
  prReviews,
  projects,
  repositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { GitProvider } from "@stubwise/git";
import type { NotificationEvent, PublishOpts } from "@stubwise/notifications";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AgentTimeoutError,
  type AgentRunner,
  type AgentRunResult,
} from "../agent/runner.js";
import type { MirrorManager } from "../git/mirrors.js";
import { GRAPHIFY_AGENT_ALLOWED_TOOLS } from "../graph/agent-hint.js";
import {
  PR_REVIEW_COMMENT_MARKER,
  runPrReview,
  type PrReviewJobRow,
  type RunPrReviewDeps,
} from "./run-review.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  // pr_reviews/agent_runs/tickets/comments cascano da projects (via repositories
  // e tickets); i run legati alle review cascano da pr_reviews.
  await testDb.db.delete(prReviews);
  await testDb.db.delete(agentRuns);
  await testDb.db.delete(projects);
  await testDb.db.delete(gitAccounts);
  await testDb.db.delete(aiProviders);
  // Riporta il singleton delle impostazioni allo stato di default.
  await testDb.db
    .update(instanceSettings)
    .set({
      contentLanguage: "en",
      monthlyBudgetUsd: null,
      prReviewEnabled: false,
      prReviewMaxCostUsd: null,
    })
    .where(eq(instanceSettings.id, 1));
});

afterAll(async () => {
  await testDb.stop();
});

/** Abilita l'automazione PR Review (e opzionalmente budget/cap) sul singleton. */
async function enableReview(
  db: Db,
  opts: { maxCostUsd?: string | null; monthlyBudgetUsd?: string | null } = {},
): Promise<void> {
  await db
    .update(instanceSettings)
    .set({
      prReviewEnabled: true,
      prReviewMaxCostUsd: opts.maxCostUsd ?? null,
      monthlyBudgetUsd: opts.monthlyBudgetUsd ?? null,
    })
    .where(eq(instanceSettings.id, 1));
}

/** Progetto + repository con credenziali git CIFRATE (pattern auto-update.test). */
async function createRepository(db: Db): Promise<{ projectId: string; repositoryId: string }> {
  const [account] = await db
    .insert(gitAccounts)
    .values({
      name: `Account review ${randomUUID()}`,
      provider: "github",
      encryptedCredentials: encrypt(JSON.stringify({ token: "tok" }), ENCRYPTION_KEY),
    })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      name: "Progetto review",
      slug: `review-${randomUUID()}`,
      ingestionKey: randomUUID(),
    })
    .returning();
  const [repository] = await db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: "Repo review",
      slug: `repo-${randomUUID()}`,
      provider: "github",
      gitAccountId: account!.id,
      repoUrl: "https://example.com/owner/repo",
      defaultBranch: "main",
    })
    .returning();
  return { projectId: project!.id, repositoryId: repository!.id };
}

function makeJob(repositoryId: string, overrides: Partial<PrReviewJobRow> = {}): PrReviewJobRow {
  return {
    repositoryId,
    prNumber: 7,
    prUrl: "https://example.com/owner/repo/pull/7",
    prTitle: "Fix login flow",
    prBody: "Correzione del flusso di login.",
    sourceBranch: "feature/login",
    targetBranch: "main",
    headSha: "a".repeat(40),
    ...overrides,
  };
}

const REVIEW_JSON = JSON.stringify({
  verdict: "request_changes",
  summary: "- `src/x.ts:3`: bug nella condizione",
});

function makeRunResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    output: REVIEW_JSON,
    exitCode: 0,
    usage: {
      totalCostUsd: 0.5,
      models: [
        {
          model: "claude-sonnet",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          costUsd: 0.5,
        },
      ],
    },
    ...overrides,
  };
}

interface Fakes {
  deps: RunPrReviewDeps;
  runner: { run: ReturnType<typeof vi.fn> };
  mirrors: {
    withWorktreeAtSha: ReturnType<typeof vi.fn>;
    getPrDiff: ReturnType<typeof vi.fn>;
  };
  upsertPrComment: ReturnType<typeof vi.fn>;
  getPullRequestState: ReturnType<typeof vi.fn>;
  /** Notifiche pubblicate: evento + riferimenti. */
  dispatched: { event: NotificationEvent; opts: PublishOpts }[];
}

function makeFakes(overrides: Partial<RunPrReviewDeps> = {}): Fakes {
  const mirrors = {
    withWorktreeAtSha: vi.fn(
      async (_p: unknown, _sha: string, fn: (dir: string) => Promise<unknown>) =>
        fn("/tmp/fake-worktree"),
    ),
    getPrDiff: vi.fn(async () => ({ diff: "diff --git a/x b/x\n+1", truncated: false })),
  };
  const runner = { run: vi.fn(async () => makeRunResult()) };
  const upsertPrComment = vi.fn(async () => {});
  const getPullRequestState = vi.fn(async () => "open" as const);
  const dispatched: { event: NotificationEvent; opts: PublishOpts }[] = [];
  const deps: RunPrReviewDeps = {
    db: testDb.db,
    mirrors: mirrors as unknown as Pick<MirrorManager, "withWorktreeAtSha" | "getPrDiff">,
    runner: runner as unknown as AgentRunner,
    encryptionKey: ENCRYPTION_KEY,
    model: "sonnet",
    maxTurns: 30,
    agentTimeoutMs: 60_000,
    publicUrl: "https://stubwise.example.com",
    getProviderFn: () =>
      ({ upsertPrComment, getPullRequestState }) as unknown as GitProvider,
    publish: async (_db, event, opts) => {
      dispatched.push({ event, opts: opts ?? {} });
      return { published: 1 };
    },
    ...overrides,
  };
  return { deps, runner, mirrors, upsertPrComment, getPullRequestState, dispatched };
}

describe("runPrReview", () => {
  it("PR esterna: crea il ticket review, commenta, completa la riga e pubblica su PR", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    const job = makeJob(repositoryId);

    await runPrReview(fakes.deps, job);

    // Ticket di tipo review, numerato dal contatore del progetto.
    const projectTickets = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId));
    expect(projectTickets).toHaveLength(1);
    const ticket = projectTickets[0]!;
    expect(ticket.type).toBe("review");
    expect(ticket.source).toBe("webhook");
    expect(ticket.priority).toBe("medium");
    expect(ticket.number).toBe(1);
    expect(ticket.title).toBe("PR Review: Fix login flow (#7)");
    expect(ticket.body).toContain(job.prUrl);
    expect(ticket.body).toContain(job.sourceBranch);

    // Commento AI col verdetto tradotto (en) + summary.
    const ticketComments = await testDb.db
      .select()
      .from(comments)
      .where(eq(comments.ticketId, ticket.id));
    expect(ticketComments).toHaveLength(1);
    expect(ticketComments[0]!.authorType).toBe("ai");
    expect(ticketComments[0]!.body).toContain("changes requested");
    expect(ticketComments[0]!.body).toContain("`src/x.ts:3`");

    // Riga pr_reviews completata con verdict/summary/ticketId.
    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("completed");
    expect(reviews[0]!.verdict).toBe("request_changes");
    expect(reviews[0]!.summary).toContain("src/x.ts:3");
    expect(reviews[0]!.ticketId).toBe(ticket.id);
    expect(reviews[0]!.finishedAt).not.toBeNull();

    // Commento sticky sulla PR col marker.
    expect(fakes.upsertPrComment).toHaveBeenCalledTimes(1);
    const [, prNumber, marker, body] = fakes.upsertPrComment.mock.calls[0] as [
      unknown,
      number,
      string,
      string,
    ];
    expect(prNumber).toBe(7);
    expect(marker).toBe(PR_REVIEW_COMMENT_MARKER);
    expect(body).toContain(PR_REVIEW_COMMENT_MARKER);
    expect(body).toContain("changes requested");
    expect(body).toContain("Stubwise PR Review");

    // agent_runs con prReviewId e phase review.
    const runs = await testDb.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.prReviewId, reviews[0]!.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.phase).toBe("review");
    expect(runs[0]!.jobId).toBeNull();
    expect(Number(runs[0]!.costUsd)).toBeCloseTo(0.5);

    // Notifica review.completed pubblicata.
    expect(fakes.dispatched).toHaveLength(1);
    const event = fakes.dispatched[0]!.event;
    expect(event.kind).toBe("review.completed");
    if (event.kind === "review.completed") {
      expect(event.verdict).toBe("request_changes");
      expect(event.prUrl).toBe(job.prUrl);
      expect(event.ticketNumber).toBe(ticket.number);
    }
    // Riferimenti: progetto e ticket della review. NIENTE jobId — il "job"
    // della review non è un ai_job (FK di notifications.job_id).
    expect(fakes.dispatched[0]!.opts).toEqual({ projectId, ticketId: ticket.id });
  });

  it("PR stubwise: commenta il ticket esistente senza crearne uno nuovo", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const [existing] = await testDb.db
      .insert(tickets)
      .values({
        projectId,
        number: 5,
        title: "Bug del login",
        type: "bug",
        priority: "high",
        source: "manual",
      })
      .returning();
    const fakes = makeFakes();
    const job = makeJob(repositoryId, { sourceBranch: "stubwise/ticket-5" });

    await runPrReview(fakes.deps, job);

    // Nessun ticket nuovo: resta solo quello esistente.
    const projectTickets = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId));
    expect(projectTickets).toHaveLength(1);

    const ticketComments = await testDb.db
      .select()
      .from(comments)
      .where(eq(comments.ticketId, existing!.id));
    expect(ticketComments).toHaveLength(1);

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.ticketId).toBe(existing!.id);
  });

  it("re-review di una PR esterna: riusa il ticket della review precedente", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    const job = makeJob(repositoryId);

    await runPrReview(fakes.deps, job);
    await runPrReview(fakes.deps, job);

    const projectTickets = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId));
    expect(projectTickets).toHaveLength(1);

    const ticketComments = await testDb.db
      .select()
      .from(comments)
      .where(eq(comments.ticketId, projectTickets[0]!.id));
    expect(ticketComments).toHaveLength(2);

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      expect(review.status).toBe("completed");
      expect(review.ticketId).toBe(projectTickets[0]!.id);
    }
  });

  it("PR esterna chiusa DURANTE la review: riga completed senza ticket, nessuna pubblicazione", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    // Aperta al gate iniziale, chiusa alla ri-verifica pre-creazione del
    // ticket: race col webhook di chiusura mentre l'agente gira (il webhook
    // non trova alcun ticket da chiudere perché ticketId è ancora null).
    fakes.getPullRequestState
      .mockResolvedValueOnce("open")
      .mockResolvedValueOnce("closed");

    await runPrReview(fakes.deps, makeJob(repositoryId));

    // La riga si chiude completed (storico e costi restano) ma SENZA ticket.
    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("completed");
    expect(reviews[0]!.verdict).toBe("request_changes");
    expect(reviews[0]!.summary).toContain("src/x.ts:3");
    expect(reviews[0]!.ticketId).toBeNull();
    expect(reviews[0]!.finishedAt).not.toBeNull();

    // Nessun ticket creato (resterebbe aperto per sempre), nessuna
    // pubblicazione sulla PR, nessuna notifica.
    const projectTickets = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId));
    expect(projectTickets).toHaveLength(0);
    expect(fakes.upsertPrComment).not.toHaveBeenCalled();
    expect(fakes.dispatched).toHaveLength(0);
    expect(fakes.getPullRequestState).toHaveBeenCalledTimes(2);
  });

  it("PR già chiusa al claim: nessuna riga, agente mai invocato", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.getPullRequestState.mockResolvedValue("closed");

    await runPrReview(fakes.deps, makeJob(repositoryId));

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(0);
    expect(fakes.runner.run).not.toHaveBeenCalled();
  });

  it("toggle spento al claim: return silenzioso, nessuna riga", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    // prReviewEnabled resta false (default post-afterEach).
    const fakes = makeFakes();

    await runPrReview(fakes.deps, makeJob(repositoryId));

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(0);
    expect(fakes.runner.run).not.toHaveBeenCalled();
    expect(fakes.getPullRequestState).not.toHaveBeenCalled();
  });

  it("output non parsabile: riga failed, nessun commento né ticket", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "nessun JSON qui" }));

    await runPrReview(fakes.deps, makeJob(repositoryId));

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("failed");
    expect(reviews[0]!.error).toContain("non parsabile");
    expect(reviews[0]!.verdict).toBeNull();

    // Il ticket per la PR esterna NON va creato quando la review fallisce.
    const projectTickets = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId));
    expect(projectTickets).toHaveLength(0);
    expect(fakes.upsertPrComment).not.toHaveBeenCalled();
    expect(fakes.dispatched).toHaveLength(0);

    // I costi del run si registrano comunque (l'agente è girato).
    const runs = await testDb.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.prReviewId, reviews[0]!.id));
    expect(runs).toHaveLength(1);
  });

  it("budget mensile sforato: riga failed, agente mai invocato", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db, { monthlyBudgetUsd: "50" });
    const fakes = makeFakes({ monthlyCostUsdFn: async () => 100 });

    await runPrReview(fakes.deps, makeJob(repositoryId));

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("failed");
    expect(reviews[0]!.error).toMatch(/budget mensile/i);
    expect(fakes.runner.run).not.toHaveBeenCalled();
  });

  it("cap per-review sforato: failed sul costo, NESSUNA pubblicazione", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db, { maxCostUsd: "0.01" });
    const fakes = makeFakes(); // usage costUsd 0.5 > cap 0.01

    await runPrReview(fakes.deps, makeJob(repositoryId));

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("failed");
    expect(reviews[0]!.error).toMatch(/costo/i);

    const projectTickets = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId));
    expect(projectTickets).toHaveLength(0);
    expect(fakes.upsertPrComment).not.toHaveBeenCalled();
    expect(fakes.dispatched).toHaveLength(0);
  });

  it("upsertPrComment fallisce: review completed comunque, commento ticket presente", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.upsertPrComment.mockRejectedValue(new Error("403 dal provider"));

    await runPrReview(fakes.deps, makeJob(repositoryId));

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("completed");

    const projectTickets = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId));
    expect(projectTickets).toHaveLength(1);
    const ticketComments = await testDb.db
      .select()
      .from(comments)
      .where(eq(comments.ticketId, projectTickets[0]!.id));
    expect(ticketComments).toHaveLength(1);
  });

  it("AgentTimeoutError: riga failed col messaggio del timeout", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockRejectedValue(new AgentTimeoutError(1000, "output parziale"));

    await runPrReview(fakes.deps, makeJob(repositoryId));

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("failed");
    expect(reviews[0]!.error).toContain("timeout");
    expect(fakes.upsertPrComment).not.toHaveBeenCalled();
  });

  it("limite del provider: riga failed con errore esplicito E job riaccodato in pr_review_jobs con notBefore ~+30'", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(
      makeRunResult({ output: "API error: rate limit reached", exitCode: 1 }),
    );
    const job = makeJob(repositoryId);

    const before = Date.now();
    await runPrReview(fakes.deps, job);
    const after = Date.now();

    // Riga failed con errore esplicito che segnala il riaccodo.
    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("failed");
    expect(reviews[0]!.error).toMatch(/limite/i);
    expect(reviews[0]!.error).toContain("riaccodata");

    // Job riaccodato con TUTTI i campi del job originale e notBefore ~+30'.
    const jobs = await testDb.db
      .select()
      .from(prReviewJobs)
      .where(eq(prReviewJobs.repositoryId, repositoryId));
    expect(jobs).toHaveLength(1);
    const requeued = jobs[0]!;
    expect(requeued.prNumber).toBe(job.prNumber);
    expect(requeued.prUrl).toBe(job.prUrl);
    expect(requeued.prTitle).toBe(job.prTitle);
    expect(requeued.prBody).toBe(job.prBody);
    expect(requeued.sourceBranch).toBe(job.sourceBranch);
    expect(requeued.targetBranch).toBe(job.targetBranch);
    expect(requeued.headSha).toBe(job.headSha);
    expect(requeued.notBefore.getTime()).toBeGreaterThanOrEqual(before + 29 * 60 * 1000);
    expect(requeued.notBefore.getTime()).toBeLessThanOrEqual(after + 31 * 60 * 1000);

    // Nessun ticket, nessun commento, nessuna notifica, nessuno sticky sulla PR.
    const projectTickets = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId));
    expect(projectTickets).toHaveLength(0);
    expect(fakes.upsertPrComment).not.toHaveBeenCalled();
    expect(fakes.dispatched).toHaveLength(0);
  });

  it("riaccodo su limite con job già presente in coda (webhook ha ri-upsertato un push più nuovo): aggiorna SOLO notBefore, i metadati del webhook vincono", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(
      makeRunResult({ output: "API error: rate limit reached", exitCode: 1 }),
    );
    const job = makeJob(repositoryId);

    // Mentre la review girava, un webhook ha ri-upsertato il job con un push
    // più nuovo (head e metadati diversi) e la sua finestra di debounce.
    const newerHeadSha = "b".repeat(40);
    await testDb.db.insert(prReviewJobs).values({
      repositoryId,
      prNumber: job.prNumber,
      prUrl: job.prUrl,
      prTitle: "Fix login flow (v2)",
      prBody: "Push più nuovo.",
      sourceBranch: job.sourceBranch,
      targetBranch: job.targetBranch,
      headSha: newerHeadSha,
      notBefore: new Date(),
    });

    const before = Date.now();
    await runPrReview(fakes.deps, job);
    const after = Date.now();

    // Un solo job per (repo, PR): i metadati del webhook restano intatti,
    // il riaccodo ha spostato SOLO la finestra notBefore oltre il cooldown.
    const jobs = await testDb.db
      .select()
      .from(prReviewJobs)
      .where(eq(prReviewJobs.repositoryId, repositoryId));
    expect(jobs).toHaveLength(1);
    const requeued = jobs[0]!;
    expect(requeued.headSha).toBe(newerHeadSha);
    expect(requeued.prTitle).toBe("Fix login flow (v2)");
    expect(requeued.prBody).toBe("Push più nuovo.");
    expect(requeued.notBefore.getTime()).toBeGreaterThanOrEqual(before + 29 * 60 * 1000);
    expect(requeued.notBefore.getTime()).toBeLessThanOrEqual(after + 31 * 60 * 1000);
  });

  it("run crashato (exit non-zero SENZA marcatore) con JSON valido nell'output: riga failed, NIENTE pubblicazione", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    // runner.run RISOLVE anche su exit ≠ 0 (vedi claude-cli.ts): l'output
    // parziale contiene un JSON di review valido, ma un verdetto da un run
    // fallito non va MAI pubblicato.
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: REVIEW_JSON, exitCode: 1 }));

    await runPrReview(fakes.deps, makeJob(repositoryId));

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("failed");
    expect(reviews[0]!.error).toContain("exit 1");
    expect(reviews[0]!.verdict).toBeNull();

    // Nessun ticket, nessun commento sulla PR, nessuna notifica.
    const projectTickets = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId));
    expect(projectTickets).toHaveLength(0);
    expect(fakes.upsertPrComment).not.toHaveBeenCalled();
    expect(fakes.dispatched).toHaveLength(0);

    // I costi del run si registrano comunque (la spesa è avvenuta).
    const runs = await testDb.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.prReviewId, reviews[0]!.id));
    expect(runs).toHaveLength(1);
  });

  it("provider pinned del progetto non risolvibile: riga failed senza fallback, agente mai invocato", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    // Un provider reale (FK valida) pinnato sul progetto, reso "non risolvibile"
    // al run (disabilitato/eliminato) iniettando un loadProviderByIdFn che
    // ritorna null — stesso pattern dei test di auto-update.ts.
    const [provider] = await testDb.db
      .insert(aiProviders)
      .values({
        label: "Pinned review",
        kind: "api_key",
        secretEncrypted: encrypt("sk-review", ENCRYPTION_KEY),
        enabled: true,
        position: 0,
      })
      .returning();
    await testDb.db
      .update(projects)
      .set({ aiProviderId: provider!.id })
      .where(eq(projects.id, projectId));
    const fakes = makeFakes({ loadProviderByIdFn: async () => null });

    await runPrReview(fakes.deps, makeJob(repositoryId));

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("failed");
    expect(reviews[0]!.error).toMatch(/provider AI/i);
    expect(fakes.runner.run).not.toHaveBeenCalled();
    expect(fakes.upsertPrComment).not.toHaveBeenCalled();
    expect(fakes.dispatched).toHaveLength(0);
  });
});

describe("runPrReview — grafo del codice (fase 2d graphify)", () => {
  let graphsDir: string;

  beforeAll(async () => {
    graphsDir = await mkdtemp(join(tmpdir(), "stubwise-review-graphs-"));
  });

  afterAll(async () => {
    await rm(graphsDir, { recursive: true, force: true });
  });

  /** Scrive il graph.json del repository sul "volume" della fixture. */
  async function writeRepoGraph(repositoryId: string, content: string): Promise<void> {
    const outDir = join(graphsDir, repositoryId, "graphify-out");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "graph.json"), content);
  }

  /**
   * Grafo minimo ma realistico: `buildApp()` in src/app.ts collegato a 12 route
   * (grado 12 ⇒ god node) e due utility nello stesso file di src/utils/slug.ts.
   */
  function starGraphJson(): string {
    const nodes: unknown[] = [
      {
        id: "hub",
        label: "buildApp()",
        source_file: "src/app.ts",
        community: 1,
        community_name: "Core",
      },
    ];
    const links: unknown[] = [];
    for (let i = 1; i <= 12; i++) {
      nodes.push({
        id: `leaf${i}`,
        label: `route${i}()`,
        source_file: `src/routes/route${i}.ts`,
        community: 2,
        community_name: "Routes",
      });
      links.push({ source: "hub", target: `leaf${i}` });
    }
    return JSON.stringify({ directed: true, multigraph: false, nodes, links });
  }

  /** Diff che tocca un file del grafo e uno fuori. */
  const DIFF = [
    "diff --git a/src/app.ts b/src/app.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/README.md b/README.md",
    "@@ -1 +1 @@",
    "+doc",
  ].join("\n");

  it("repo col grafo: blocchi nel prompt, allowlist sul run e sezione nei commenti", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    await writeRepoGraph(repositoryId, starGraphJson());
    const fakes = makeFakes({ graphsDir });
    fakes.mirrors.getPrDiff.mockResolvedValue({ diff: DIFF, truncated: false });

    await runPrReview(fakes.deps, makeJob(repositoryId));

    // Prompt: blocco CODE GRAPH col path del volume + impatto deterministico.
    const runArgs = fakes.runner.run.mock.calls[0]![0] as {
      prompt: string;
      allowedTools?: string[];
    };
    expect(runArgs.prompt).toContain("CODE GRAPH:");
    expect(runArgs.prompt).toContain(join(graphsDir, repositoryId, "graphify-out", "graph.json"));
    expect(runArgs.prompt).toContain("## Code graph impact");
    expect(runArgs.prompt).toContain("Core (files: 1, symbols: 1)");
    expect(runArgs.prompt).toContain("`buildApp()` (degree 12)");
    // Allowlist dei comandi read-only del CLI sul run plan-mode.
    expect(runArgs.allowedTools).toEqual(GRAPHIFY_AGENT_ALLOWED_TOOLS);

    // Sezione "Impatto sul codice" (lingua d'istanza: en nei test) appesa DOPO
    // l'output dell'agente, sia sul commento del ticket sia su quello della PR.
    const [ticketComment] = await testDb.db.select().from(comments);
    expect(ticketComment!.body).toContain("Code impact");
    expect(ticketComment!.body).toContain("Areas crossed: Core (files: 1, symbols: 1)");
    expect(ticketComment!.body).toContain("`buildApp()` (degree 12)");
    expect(ticketComment!.body).toContain("Files touched: 1 in the graph, 1 outside it");
    // L'ordine è: verdetto, testo dell'agente, sezione deterministica.
    expect(ticketComment!.body.indexOf("src/x.ts:3")).toBeLessThan(
      ticketComment!.body.indexOf("Code impact"),
    );

    const prBody = fakes.upsertPrComment.mock.calls[0]![3] as string;
    expect(prBody).toContain("Code impact");
    expect(prBody).toContain("Stubwise PR Review");

    // La riga pr_reviews conserva la summary PURA dell'agente (l'impatto è
    // una decorazione dei commenti, non un dato prodotto dalla review).
    const [review] = await testDb.db.select().from(prReviews);
    expect(review!.status).toBe("completed");
    expect(review!.summary).toBe("- `src/x.ts:3`: bug nella condizione");
  });

  it("nessun file del diff nel grafo: niente sezione, review invariata", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    await writeRepoGraph(repositoryId, starGraphJson());
    const fakes = makeFakes({ graphsDir });
    fakes.mirrors.getPrDiff.mockResolvedValue({
      diff: "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n+doc",
      truncated: false,
    });

    await runPrReview(fakes.deps, makeJob(repositoryId));

    const runArgs = fakes.runner.run.mock.calls[0]![0] as { prompt: string };
    expect(runArgs.prompt).toContain("CODE GRAPH:"); // il grafo c'è comunque
    expect(runArgs.prompt).not.toContain("## Code graph impact");
    const [ticketComment] = await testDb.db.select().from(comments);
    expect(ticketComment!.body).not.toContain("Code impact");
  });

  it("fail-open: graph.json corrotto → review completata senza sezione", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    await writeRepoGraph(repositoryId, '{"nodes": [ {"id": "rotto"');
    const fakes = makeFakes({ graphsDir });
    fakes.mirrors.getPrDiff.mockResolvedValue({ diff: DIFF, truncated: false });

    await runPrReview(fakes.deps, makeJob(repositoryId));

    const [review] = await testDb.db.select().from(prReviews);
    expect(review!.status).toBe("completed");
    const runArgs = fakes.runner.run.mock.calls[0]![0] as {
      prompt: string;
      allowedTools?: string[];
    };
    // Il file esiste: l'hint e l'allowlist restano (il CLI se la vedrà con un
    // grafo illeggibile); solo l'impatto deterministico sparisce.
    expect(runArgs.prompt).toContain("CODE GRAPH:");
    expect(runArgs.allowedTools).toEqual(GRAPHIFY_AGENT_ALLOWED_TOOLS);
    expect(runArgs.prompt).not.toContain("## Code graph impact");
    const [ticketComment] = await testDb.db.select().from(comments);
    expect(ticketComment!.body).not.toContain("Code impact");
    expect(fakes.upsertPrComment).toHaveBeenCalledTimes(1);
  });

  it("repo senza grafo (o graphsDir non cablata): review byte-identica a prima", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    // graphsDir cablata ma NESSUN graph.json per questo repository.
    const withDir = makeFakes({ graphsDir });
    withDir.mirrors.getPrDiff.mockResolvedValue({ diff: DIFF, truncated: false });
    await runPrReview(withDir.deps, makeJob(repositoryId));

    const withDirArgs = withDir.runner.run.mock.calls[0]![0] as {
      prompt: string;
      allowedTools?: string[];
    };
    expect(withDirArgs.prompt).not.toContain("CODE GRAPH");
    expect(withDirArgs.prompt).not.toContain("## Code graph impact");
    expect(withDirArgs.allowedTools).toBeUndefined();
    const [ticketComment] = await testDb.db.select().from(comments);
    expect(ticketComment!.body).not.toContain("Code impact");
    const withDirPrBody = withDir.upsertPrComment.mock.calls[0]![3] as string;

    // Stesso job SENZA graphsDir: prompt e commento pubblicato identici.
    const { repositoryId: otherRepo } = await createRepository(testDb.db);
    const withoutDir = makeFakes();
    withoutDir.mirrors.getPrDiff.mockResolvedValue({ diff: DIFF, truncated: false });
    await runPrReview(withoutDir.deps, makeJob(otherRepo));

    const withoutDirArgs = withoutDir.runner.run.mock.calls[0]![0] as {
      prompt: string;
      allowedTools?: string[];
    };
    expect(withoutDirArgs.prompt).toBe(withDirArgs.prompt);
    expect(withoutDirArgs.allowedTools).toBeUndefined();
    expect(withoutDir.upsertPrComment.mock.calls[0]![3]).toBe(withDirPrBody);
  });
});
