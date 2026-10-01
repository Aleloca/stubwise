import {
  agentRuns,
  aiJobs,
  aiProviders,
  comments,
  encrypt,
  gitAccounts,
  instanceSettings,
  prCorrections,
  prReviewJobs,
  prReviews,
  projects,
  repositories,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import type { GitProvider } from "@stubwise/git";
import type { NotificationEvent, PublishOpts } from "@stubwise/notifications";
import { hasStubwiseReviewSignature } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
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
import type { MirrorManager, MirrorProject } from "../git/mirrors.js";
import { GRAPHIFY_AGENT_ALLOWED_TOOLS } from "../graph/agent-hint.js";
import { dropIfNeverStarted } from "./poller.js";
import {
  insertWaitingReview,
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

/**
 * Come il poller: riga in attesa al claim, poi la review su quella riga, poi la
 * pulizia della riga se non è mai partita (`dropIfNeverStarted`).
 */
async function runClaimed(deps: RunPrReviewDeps, job: PrReviewJobRow): Promise<string> {
  const reviewId = await insertWaitingReview(deps.db, job);
  try {
    await runPrReview(deps, job, reviewId);
  } finally {
    await dropIfNeverStarted(deps.db, reviewId);
  }
  return reviewId;
}

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

// Il doppio dei mirror e del provider git è SENZA cast sull'oggetto intero e
// con TUTTI i metodi del `Pick` di RunPrReviewDeps (terza trappola di
// CLAUDE.md, «il doppio del client»): un metodo mancante lo dice il
// compilatore, non un TypeError inghiottito dal best-effort.
function makeFakes(overrides: Partial<RunPrReviewDeps> = {}) {
  const withWorktreeAtSha = vi.fn(
    async (_p: MirrorProject, _sha: string, fn: (dir: string) => Promise<unknown>) =>
      fn("/tmp/fake-worktree"),
  );
  const mirrors = {
    withWorktreeAtSha,
    getPrDiff: vi.fn<MirrorManager["getPrDiff"]>(async () => ({
      diff: "diff --git a/x b/x\n+1",
      truncated: false,
    })),
    // Lo sha COMPLETO che il mirror risolverebbe da una head abbreviata.
    resolveCommitSha: vi.fn(async (_p: MirrorProject, sha: string) => sha.padEnd(40, "0")),
  };
  const runner = { run: vi.fn<AgentRunner["run"]>(async () => makeRunResult()) };
  const createPrComment = vi.fn<GitProvider["createPrComment"]>(async () => {});
  const getPullRequestState = vi.fn<GitProvider["getPullRequestState"]>(async () => "open");
  const submitPrReview = vi.fn<GitProvider["submitPrReview"]>(async () => ({ status: "submitted" }));
  const setCommitStatus = vi.fn<GitProvider["setCommitStatus"]>(async () => {});
  /** Notifiche pubblicate: evento + riferimenti. */
  const dispatched: { event: NotificationEvent; opts: PublishOpts }[] = [];
  const deps: RunPrReviewDeps = {
    db: testDb.db,
    mirrors: {
      // Unico `as`: il VALORE di ritorno del metodo generico, non l'oggetto.
      withWorktreeAtSha: <T,>(p: MirrorProject, sha: string, fn: (dir: string) => Promise<T>) =>
        withWorktreeAtSha(p, sha, fn) as Promise<T>,
      getPrDiff: mirrors.getPrDiff,
      resolveCommitSha: mirrors.resolveCommitSha,
    },
    runner,
    encryptionKey: ENCRYPTION_KEY,
    model: "sonnet",
    maxTurns: 30,
    agentTimeoutMs: 60_000,
    staleMinutes: 150,
    publicUrl: "https://stubwise.example.com",
    getProviderFn: () => ({ createPrComment, getPullRequestState, submitPrReview, setCommitStatus }),
    publish: async (_db, event, opts) => {
      dispatched.push({ event, opts: opts ?? {} });
      return { published: 1, notificationIds: [randomUUID()] };
    },
    // Riassunto "in breve" della PR SPENTO di default nei test: è un run in più
    // dell'agente e falserebbe i conteggi di `runner.run` di tutti gli altri
    // casi. I test che lo riguardano lo riaccendono con override.
    summariesEnabled: false,
    ...overrides,
  };
  return {
    deps,
    runner,
    mirrors,
    createPrComment,
    getPullRequestState,
    submitPrReview,
    setCommitStatus,
    dispatched,
  };
}

describe("runPrReview", () => {
  it("PR esterna: crea il ticket review, commenta, completa la riga e pubblica su PR", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    const job = makeJob(repositoryId);

    await runClaimed(fakes.deps, job);

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

    // Commento NUOVO sulla PR, firmato col commit rivisto.
    expect(fakes.createPrComment).toHaveBeenCalledTimes(1);
    const [, prNumber, body] = fakes.createPrComment.mock.calls[0] as [
      unknown,
      number,
      string,
    ];
    expect(prNumber).toBe(7);
    expect(body).toContain("changes requested");
    expect(body).toContain("Stubwise PR Review · `aaaaaaa`");
    // Il corpo PUBBLICATO davvero è quello che la fotografia dei commenti e il
    // webhook riconoscono come review di Stubwise.
    expect(hasStubwiseReviewSignature(body)).toBe(true);

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

    await runClaimed(fakes.deps, job);

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

    await runClaimed(fakes.deps, job);
    // Un push NUOVO: la stessa head sarebbe un doppione, saltato di proposito.
    await runClaimed(fakes.deps, { ...job, headSha: "b".repeat(40) });

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

    await runClaimed(fakes.deps, makeJob(repositoryId));

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
    expect(fakes.createPrComment).not.toHaveBeenCalled();
    expect(fakes.dispatched).toHaveLength(0);
    expect(fakes.getPullRequestState).toHaveBeenCalledTimes(2);
  });

  it("PR già chiusa al claim: nessuna riga, agente mai invocato", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.getPullRequestState.mockResolvedValue("closed");

    await runClaimed(fakes.deps, makeJob(repositoryId));

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

    await runClaimed(fakes.deps, makeJob(repositoryId));

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

    await runClaimed(fakes.deps, makeJob(repositoryId));

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
    expect(fakes.createPrComment).not.toHaveBeenCalled();
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

    await runClaimed(fakes.deps, makeJob(repositoryId));

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

    await runClaimed(fakes.deps, makeJob(repositoryId));

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
    expect(fakes.createPrComment).not.toHaveBeenCalled();
    expect(fakes.dispatched).toHaveLength(0);
  });

  it("riassunto in breve della PR scritto nella STESSA riga di verdetto e analisi", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes({ summariesEnabled: true, summaryModel: "haiku" });
    // Primo run: la review (JSON). Secondo run: il riassunto (testo libero).
    fakes.runner.run
      .mockImplementationOnce(async () => makeRunResult())
      .mockImplementationOnce(async () =>
        makeRunResult({ output: "La PR sistema il login. La review chiede una correzione." }),
      );

    await runClaimed(fakes.deps, makeJob(repositoryId));

    expect(fakes.runner.run).toHaveBeenCalledTimes(2);
    const summaryCall = fakes.runner.run.mock.calls[1]![0] as { prompt: string; model?: string };
    expect(summaryCall.model).toBe("haiku");
    // Il riassunto traduce il verdetto e l'analisi appena parsati, non il diff.
    expect(summaryCall.prompt).toContain("request_changes");
    expect(summaryCall.prompt).toContain("bug nella condizione");

    const [review] = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(review!.status).toBe("completed");
    expect(review!.verdict).toBe("request_changes");
    expect(review!.prSummary).toBe("La PR sistema il login. La review chiede una correzione.");

    // E viaggia anche nell'EVENTO: la consegna webhook/Slack parte dal payload
    // pubblicato, non da una rilettura del DB.
    const event = fakes.dispatched[0]!.event;
    expect(event).toMatchObject({
      kind: "review.completed",
      summary: "La PR sistema il login. La review chiede una correzione.",
    });
  });

  it("riassunto fallito: pr_summary NULL e review comunque completed", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes({ summariesEnabled: true });
    fakes.runner.run
      .mockImplementationOnce(async () => makeRunResult())
      .mockImplementationOnce(async () => makeRunResult({ output: "parziale", exitCode: 1 }));

    await runClaimed(fakes.deps, makeJob(repositoryId));

    const [review] = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(review!.status).toBe("completed");
    expect(review!.verdict).toBe("request_changes");
    expect(review!.prSummary).toBeNull();
  });

  it("review scartata dal cap di costo: NESSUN run di riassunto", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db, { maxCostUsd: "0.01" });
    const fakes = makeFakes({ summariesEnabled: true }); // usage 0.5 > cap 0.01

    await runClaimed(fakes.deps, makeJob(repositoryId));

    // Un solo run: quello della review, poi scartato. Non si paga un riassunto
    // di un risultato che nessuno vedrà.
    expect(fakes.runner.run).toHaveBeenCalledTimes(1);
    const [review] = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(review!.status).toBe("failed");
    expect(review!.prSummary).toBeNull();
  });

  it("createPrComment fallisce: review completed comunque, commento ticket presente", async () => {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.createPrComment.mockRejectedValue(new Error("403 dal provider"));

    await runClaimed(fakes.deps, makeJob(repositoryId));

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

    await runClaimed(fakes.deps, makeJob(repositoryId));

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("failed");
    expect(reviews[0]!.error).toContain("timeout");
    expect(fakes.createPrComment).not.toHaveBeenCalled();
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
    await runClaimed(fakes.deps, job);
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

    // Nessun ticket, nessun commento, nessuna notifica, nessun commento sulla PR.
    const projectTickets = await testDb.db
      .select()
      .from(tickets)
      .where(eq(tickets.projectId, projectId));
    expect(projectTickets).toHaveLength(0);
    expect(fakes.createPrComment).not.toHaveBeenCalled();
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
    await runClaimed(fakes.deps, job);
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

    await runClaimed(fakes.deps, makeJob(repositoryId));

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
    expect(fakes.createPrComment).not.toHaveBeenCalled();
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

    await runClaimed(fakes.deps, makeJob(repositoryId));

    const reviews = await testDb.db
      .select()
      .from(prReviews)
      .where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.status).toBe("failed");
    expect(reviews[0]!.error).toMatch(/provider AI/i);
    expect(fakes.runner.run).not.toHaveBeenCalled();
    expect(fakes.createPrComment).not.toHaveBeenCalled();
    expect(fakes.dispatched).toHaveLength(0);
  });

  it("stessa head già revisionata (webhook arrivato dopo il claim): niente run, niente riga", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    // La review accodata dal worker, sha completo.
    await runClaimed(fakes.deps, makeJob(repositoryId, { headSha: "c".repeat(40) }));
    // Il webhook Bitbucket della stessa head, abbreviata.
    await runClaimed(fakes.deps, makeJob(repositoryId, { headSha: "c".repeat(12) }));

    expect(fakes.runner.run).toHaveBeenCalledTimes(1);
    const reviews = await testDb.db.select().from(prReviews).where(eq(prReviews.repositoryId, repositoryId));
    expect(reviews).toHaveLength(1);
  });

  it("status di commit: in corso all'avvio, poi l'esito del verdetto, sullo sha completo", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();

    await runClaimed(fakes.deps, makeJob(repositoryId, { headSha: "d".repeat(12) }));

    const states = fakes.setCommitStatus.mock.calls.map((c) => c[2].state);
    expect(states).toEqual(["pending", "failure"]);
    // Lo sha passato alle API è quello COMPLETO risolto dal mirror.
    expect(fakes.mirrors.resolveCommitSha).toHaveBeenCalledWith(expect.anything(), "d".repeat(12));
    expect(fakes.setCommitStatus.mock.calls.map((c) => c[1])).toEqual([
      "d".repeat(12).padEnd(40, "0"),
      "d".repeat(12).padEnd(40, "0"),
    ]);
    expect(fakes.setCommitStatus.mock.calls[0]![2]).toMatchObject({ key: "stubwise-review", refname: "feature/login" });
    // Risolto UNA volta alla partenza: l'esito va sullo stesso sha del pending.
    expect(fakes.mirrors.resolveCommitSha).toHaveBeenCalledTimes(1);
  });

  it("review fallita DOPO la partenza: lo status in corso diventa failure (niente PR bloccata)", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "nessun JSON qui" }));

    await runClaimed(fakes.deps, makeJob(repositoryId));

    expect(fakes.setCommitStatus.mock.calls.map((c) => c[2].state)).toEqual(["pending", "failure"]);
    expect(fakes.setCommitStatus.mock.calls[1]![2].description).toBe("The Stubwise review did not complete");
    expect(fakes.setCommitStatus.mock.calls[1]![1]).toBe(fakes.setCommitStatus.mock.calls[0]![1]);
  });

  it("riga già chiusa dal recovery mentre girava: il fallimento non riscrive lo status", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockImplementationOnce(async () => {
      // Il recovery degli stantii chiude la riga a metà run.
      await testDb.db.update(prReviews).set({ status: "failed", error: "stantia" }).where(eq(prReviews.repositoryId, repositoryId));
      return makeRunResult({ output: "nessun JSON qui" });
    });

    await runClaimed(fakes.deps, makeJob(repositoryId));

    // Nessuna chiusura avvenuta qui → nessun `failure` scritto da questa review.
    expect(fakes.setCommitStatus.mock.calls.map((c) => c[2].state)).toEqual(["pending"]);
  });

  it("review fallita PRIMA della partenza (budget): nessuno status, mai scritto il pending", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db, { monthlyBudgetUsd: "1" });
    const fakes = makeFakes({ monthlyCostUsdFn: async () => 5 });

    await runClaimed(fakes.deps, makeJob(repositoryId));

    expect(fakes.setCommitStatus).not.toHaveBeenCalled();
  });

  it("una riga IN ATTESA orfana (più vecchia della soglia) della stessa head non blocca la review", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes({ staleMinutes: 15 });
    const job = makeJob(repositoryId);
    // Riga in attesa rimasta appesa 3 ore fa (mai partita, mai cancellata).
    await testDb.db.insert(prReviews).values({
      repositoryId,
      prNumber: job.prNumber,
      prUrl: job.prUrl,
      prTitle: job.prTitle,
      headSha: job.headSha,
      status: "running",
      createdAt: new Date(Date.now() - 180 * 60_000),
    });

    await runClaimed(fakes.deps, job);

    expect(fakes.runner.run).toHaveBeenCalled();
  });

  it("una riga IN ATTESA recente della stessa head blocca ancora (è un doppione vivo)", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes({ staleMinutes: 15 });
    const job = makeJob(repositoryId);
    await insertWaitingReview(testDb.db, job);

    await runClaimed(fakes.deps, job);

    expect(fakes.runner.run).not.toHaveBeenCalled();
  });

  it("riusa la riga del claim: nessuna riga nuova, started_at scritto alla partenza", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    const job = makeJob(repositoryId);
    const reviewId = await insertWaitingReview(testDb.db, job);
    const [waiting] = await testDb.db.select().from(prReviews).where(eq(prReviews.id, reviewId));
    expect(waiting).toMatchObject({ status: "running", startedAt: null, sourceBranch: job.sourceBranch });

    await runPrReview(fakes.deps, job, reviewId);

    const rows = await testDb.db.select().from(prReviews).where(eq(prReviews.repositoryId, repositoryId));
    expect(rows.map((r) => r.id)).toEqual([reviewId]);
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.startedAt).not.toBeNull();
  });

  it("partenza: last_activity_at rinnovato (una review rimasta in attesa a lungo non sembra stantia)", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    const job = makeJob(repositoryId);
    const reviewId = await insertWaitingReview(testDb.db, job);
    // In attesa da 3 ore: il suo last_activity_at è quello del claim.
    await testDb.db
      .update(prReviews)
      .set({ lastActivityAt: new Date(Date.now() - 180 * 60_000) })
      .where(eq(prReviews.id, reviewId));
    let seenAtRun: Date | null = null;
    fakes.runner.run.mockImplementationOnce(async () => {
      const [row] = await testDb.db.select().from(prReviews).where(eq(prReviews.id, reviewId));
      seenAtRun = row!.lastActivityAt;
      return makeRunResult();
    });

    await runPrReview(fakes.deps, job, reviewId);

    expect(seenAtRun).not.toBeNull();
    expect(Date.now() - seenAtRun!.getTime()).toBeLessThan(60_000);
  });

  it("gate del budget: la riga in attesa diventa failed SENZA essere mai partita", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db, { monthlyBudgetUsd: "1" });
    const fakes = makeFakes({ monthlyCostUsdFn: async () => 5 });
    const reviewId = await runClaimed(fakes.deps, makeJob(repositoryId));

    const [row] = await testDb.db.select().from(prReviews).where(eq(prReviews.id, reviewId));
    expect(row).toMatchObject({ status: "failed", startedAt: null });
    expect(row!.error).toMatch(/budget/);
    expect(fakes.runner.run).not.toHaveBeenCalled();
  });

  it("la guardia anti-doppione non trova la PROPRIA riga in attesa", async () => {
    // Senza `ne(prReviews.id, reviewId)` la review vedrebbe sé stessa
    // (running, stessa head) e si salterebbe: nessun run, mai.
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    const fakes = makeFakes();

    await runClaimed(fakes.deps, makeJob(repositoryId));

    expect(fakes.runner.run).toHaveBeenCalled();
  });
});

// Emendamento E2: una review che NON arriva a un verdetto (fallita) è comunque
// un punto di promozione della richiesta umana in fila su QUESTA PR — mai di
// una correzione automatica.
describe("runPrReview — review fallita e richiesta in attesa (E2)", () => {
  /** Ticket #5 con la PR 7 di Stubwise collegata, e opzionalmente una pending. */
  async function stubwisePr(withPending: boolean) {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    const [ticket] = await testDb.db
      .insert(tickets)
      .values({ projectId, number: 5, title: "Bug", type: "bug", priority: "high", source: "manual" })
      .returning();
    await testDb.db.insert(ticketRepositories).values({
      ticketId: ticket!.id,
      repositoryId,
      branch: "stubwise/ticket-5",
      prUrl: "https://example.com/owner/repo/pull/7",
      prState: "open",
      prNumber: 7,
    });
    const [pending] = withPending
      ? await testDb.db
          .insert(prCorrections)
          .values({ ticketId: ticket!.id, repositoryId, prNumber: 7, trigger: "stubwise", status: "pending" })
          .returning()
      : [];
    return { repositoryId, ticketId: ticket!.id, pendingId: pending?.id ?? null };
  }

  it("review fallita con una pending sulla PR: la pending diventa queued col suo job", async () => {
    const pr = await stubwisePr(true);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "nessun JSON qui" }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    const [review] = await testDb.db.select().from(prReviews).where(eq(prReviews.repositoryId, pr.repositoryId));
    expect(review!.status).toBe("failed");
    const [correction] = await testDb.db.select().from(prCorrections).where(eq(prCorrections.id, pr.pendingId!));
    expect(correction!.status).toBe("queued");
    const jobs = await testDb.db.select().from(aiJobs).where(eq(aiJobs.correctionId, pr.pendingId!));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("queued");
  });

  it("review fallita al gate del budget (mai partita): la pending parte comunque", async () => {
    const pr = await stubwisePr(true);
    await enableReview(testDb.db, { monthlyBudgetUsd: "1" });
    const fakes = makeFakes({ monthlyCostUsdFn: async () => 5 });

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    const [correction] = await testDb.db.select().from(prCorrections).where(eq(prCorrections.id, pr.pendingId!));
    expect(correction!.status).toBe("queued");
  });

  it("review fallita SENZA pending: nessuna correzione creata (mai un giro automatico)", async () => {
    const pr = await stubwisePr(false);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "API error", exitCode: 1 }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    expect(await testDb.db.select().from(prCorrections).where(eq(prCorrections.repositoryId, pr.repositoryId))).toHaveLength(0);
    expect(await testDb.db.select().from(aiJobs).where(eq(aiJobs.ticketId, pr.ticketId))).toHaveLength(0);
  });

  it("limite del provider (review riaccodata): la pending NON parte, ripartirà con la review", async () => {
    const pr = await stubwisePr(true);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "API error: rate limit reached", exitCode: 1 }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    const [correction] = await testDb.db.select().from(prCorrections).where(eq(prCorrections.id, pr.pendingId!));
    expect(correction!.status).toBe("pending");
    expect(await testDb.db.select().from(prReviewJobs).where(eq(prReviewJobs.repositoryId, pr.repositoryId))).toHaveLength(1);
  });

  it("branch che non è di Stubwise: nessuna promozione", async () => {
    const pr = await stubwisePr(true);
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "nessun JSON qui" }));

    // Stessa PR 7, ma il job arriva da un branch scritto da una persona.
    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "feature/login" }));

    const [correction] = await testDb.db
      .select()
      .from(prCorrections)
      .where(and(eq(prCorrections.repositoryId, pr.repositoryId), eq(prCorrections.prNumber, 7)));
    expect(correction!.status).toBe("pending");
  });
});

// C10b: dentro una serie di correzioni automatiche una review FALLITA spegne il
// ciclo. Si avvisa con `review.completed` (mai un kind nuovo), verdetto nullo e
// `cycle.stoppedReason: "review_failed"`; fuori serie, e sul limite del
// provider (la review riparte), nessuna notifica.
describe("runPrReview — review fallita dentro una serie automatica (C10b)", () => {
  /**
   * Ticket #5 con la PR 7 di Stubwise, tetto 3, e le correzioni già fatte
   * sulla PR: `auto` giri automatici conclusi, più eventuali righe extra.
   */
  async function seriesPr(opts: {
    auto: number;
    extra?: { trigger: "review" | "stubwise"; status: "pending" | "queued" | "done" }[];
    /** false = nessuna riga `ticket_repositories` per il branch della PR. */
    link?: boolean;
  }) {
    const { projectId, repositoryId } = await createRepository(testDb.db);
    await testDb.db.update(projects).set({ prCorrectionMaxRounds: 3 }).where(eq(projects.id, projectId));
    const [ticket] = await testDb.db
      .insert(tickets)
      .values({ projectId, number: 5, title: "Bug", type: "bug", priority: "high", source: "manual" })
      .returning();
    if (opts.link !== false) {
      await testDb.db.insert(ticketRepositories).values({
        ticketId: ticket!.id,
        repositoryId,
        branch: "stubwise/ticket-5",
        prUrl: "https://example.com/owner/repo/pull/7",
        prState: "open",
        prNumber: 7,
      });
    }
    const rows = [
      ...Array.from({ length: opts.auto }, () => ({ trigger: "review" as const, status: "done" as const })),
      ...(opts.extra ?? []),
    ];
    for (const row of rows) {
      await testDb.db
        .insert(prCorrections)
        .values({ ticketId: ticket!.id, repositoryId, prNumber: 7, trigger: row.trigger, status: row.status });
    }
    return { projectId, repositoryId, ticketId: ticket!.id };
  }

  const reviewEvents = (fakes: ReturnType<typeof makeFakes>) =>
    fakes.dispatched.filter((d) => d.event.kind === "review.completed");

  it("fallita dentro una serie (output non parsabile): una notifica, verdetto nullo, ciclo fermato dalla review", async () => {
    const pr = await seriesPr({ auto: 2 });
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "nessun JSON qui" }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    const events = reviewEvents(fakes);
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toMatchObject({
      kind: "review.completed",
      ticketNumber: 5,
      ticketTitle: "Bug",
      prUrl: "https://example.com/owner/repo/pull/7",
      verdict: null,
      cycle: { round: 2, max: 3, stopped: true, stoppedReason: "review_failed" },
    });
    // Stessi destinatari dello stop al tetto: progetto + ticket, niente jobId.
    expect(events[0]!.opts).toEqual({ projectId: pr.projectId, ticketId: pr.ticketId });
    const [review] = await testDb.db.select().from(prReviews).where(eq(prReviews.repositoryId, pr.repositoryId));
    expect(review!.status).toBe("failed");
  });

  it("fallita dentro una serie (exit ≠ 0): stessa notifica", async () => {
    const pr = await seriesPr({ auto: 1 });
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "API error", exitCode: 1 }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    const events = reviewEvents(fakes);
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toMatchObject({
      verdict: null,
      cycle: { round: 1, max: 3, stopped: true, stoppedReason: "review_failed" },
    });
  });

  it("fallita FUORI serie (nessun giro automatico): nessuna notifica, come oggi", async () => {
    const pr = await seriesPr({ auto: 0 });
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "nessun JSON qui" }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    expect(fakes.dispatched).toHaveLength(0);
  });

  it("serie azzerata da una richiesta umana dopo i giri automatici: nessuna notifica", async () => {
    const pr = await seriesPr({ auto: 2, extra: [{ trigger: "stubwise", status: "done" }] });
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "nessun JSON qui" }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    expect(fakes.dispatched).toHaveLength(0);
  });

  it("dentro una serie ma con un giro automatico ancora in fila: il ciclo non è fermo, nessuna notifica", async () => {
    const pr = await seriesPr({ auto: 1, extra: [{ trigger: "review", status: "pending" }] });
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "nessun JSON qui" }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    expect(fakes.dispatched).toHaveLength(0);
  });

  it("limite del provider dentro una serie (review riaccodata): nessuna notifica", async () => {
    const pr = await seriesPr({ auto: 2 });
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "API error: rate limit reached", exitCode: 1 }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    expect(fakes.dispatched).toHaveLength(0);
    expect(await testDb.db.select().from(prReviewJobs).where(eq(prReviewJobs.repositoryId, pr.repositoryId))).toHaveLength(1);
  });

  it("stessa PR con un branch che non è di Stubwise: nessuna notifica", async () => {
    const pr = await seriesPr({ auto: 2 });
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "nessun JSON qui" }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "feature/login" }));

    expect(fakes.dispatched).toHaveLength(0);
  });

  it("una richiesta UMANA in attesa dentro la serie, promossa dopo la review fallita: nessuna notifica", async () => {
    const pr = await seriesPr({ auto: 2, extra: [{ trigger: "stubwise", status: "pending" }] });
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "nessun JSON qui" }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    // La richiesta umana è partita (E2): il ciclo non è fermo, qualcuno corregge.
    const human = await testDb.db
      .select()
      .from(prCorrections)
      .where(and(eq(prCorrections.repositoryId, pr.repositoryId), eq(prCorrections.trigger, "stubwise")));
    expect(human[0]!.status).toBe("queued");
    expect(fakes.dispatched).toHaveLength(0);
  });

  it("branch `stubwise/ticket-5` senza la riga `ticket_repositories` corrispondente: nessuna notifica", async () => {
    const pr = await seriesPr({ auto: 2, link: false });
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockResolvedValue(makeRunResult({ output: "nessun JSON qui" }));

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    expect(fakes.dispatched).toHaveLength(0);
  });

  it("PR chiusa DURANTE la review, poi review fallita: nessuna notifica", async () => {
    const pr = await seriesPr({ auto: 2 });
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockImplementation(async () => {
      await testDb.db
        .update(ticketRepositories)
        .set({ prState: "closed_unmerged" })
        .where(eq(ticketRepositories.ticketId, pr.ticketId));
      return makeRunResult({ output: "nessun JSON qui" });
    });

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

    const [review] = await testDb.db.select().from(prReviews).where(eq(prReviews.repositoryId, pr.repositoryId));
    expect(review!.status).toBe("failed");
    expect(fakes.dispatched).toHaveLength(0);
  });

  it("riga già chiusa dal recovery mentre girava: nessuna notifica (la chiusura non è nostra)", async () => {
    const pr = await seriesPr({ auto: 2 });
    await enableReview(testDb.db);
    const fakes = makeFakes();
    fakes.runner.run.mockImplementation(async () => {
      await testDb.db
        .update(prReviews)
        .set({ status: "failed", error: "recovery" })
        .where(eq(prReviews.repositoryId, pr.repositoryId));
      return makeRunResult({ output: "nessun JSON qui" });
    });

    await runClaimed(fakes.deps, makeJob(pr.repositoryId, { sourceBranch: "stubwise/ticket-5" }));

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

    await runClaimed(fakes.deps, makeJob(repositoryId));

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

    const prBody = fakes.createPrComment.mock.calls[0]![2] as string;
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

    await runClaimed(fakes.deps, makeJob(repositoryId));

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

    await runClaimed(fakes.deps, makeJob(repositoryId));

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
    expect(fakes.createPrComment).toHaveBeenCalledTimes(1);
  });

  it("repo senza grafo (o graphsDir non cablata): review byte-identica a prima", async () => {
    const { repositoryId } = await createRepository(testDb.db);
    await enableReview(testDb.db);
    // graphsDir cablata ma NESSUN graph.json per questo repository.
    const withDir = makeFakes({ graphsDir });
    withDir.mirrors.getPrDiff.mockResolvedValue({ diff: DIFF, truncated: false });
    await runClaimed(withDir.deps, makeJob(repositoryId));

    const withDirArgs = withDir.runner.run.mock.calls[0]![0] as {
      prompt: string;
      allowedTools?: string[];
    };
    expect(withDirArgs.prompt).not.toContain("CODE GRAPH");
    expect(withDirArgs.prompt).not.toContain("## Code graph impact");
    expect(withDirArgs.allowedTools).toBeUndefined();
    const [ticketComment] = await testDb.db.select().from(comments);
    expect(ticketComment!.body).not.toContain("Code impact");
    const withDirPrBody = withDir.createPrComment.mock.calls[0]![2] as string;

    // Stesso job SENZA graphsDir: prompt e commento pubblicato identici.
    const { repositoryId: otherRepo } = await createRepository(testDb.db);
    const withoutDir = makeFakes();
    withoutDir.mirrors.getPrDiff.mockResolvedValue({ diff: DIFF, truncated: false });
    await runClaimed(withoutDir.deps, makeJob(otherRepo));

    const withoutDirArgs = withoutDir.runner.run.mock.calls[0]![0] as {
      prompt: string;
      allowedTools?: string[];
    };
    expect(withoutDirArgs.prompt).toBe(withDirArgs.prompt);
    expect(withoutDirArgs.allowedTools).toBeUndefined();
    expect(withoutDir.createPrComment.mock.calls[0]![2]).toBe(withDirPrBody);
  });
});
