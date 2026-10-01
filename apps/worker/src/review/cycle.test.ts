import {
  aiJobs,
  encrypt,
  gitAccounts,
  prCorrections,
  prReviews,
  projects,
  repositories,
  ticketRepositories,
  tickets,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { BitbucketProvider, GitProviderError } from "@stubwise/git";
import {
  autoRoundsInCurrentSeries,
  completeCorrection,
  promotePendingForTicket,
  type NotificationEvent,
} from "@stubwise/notifications";
import { and, eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MirrorProject } from "../git/mirrors.js";
import {
  afterReviewCompleted,
  commitStatusTargetUrl,
  verdictFailureReason,
  type AfterReviewCompletedInput,
  type ReviewCycleDeps,
} from "./cycle.js";

vi.setConfig({ testTimeout: 60_000 });

const ENCRYPTION_KEY = randomBytes(32);
const FULL_SHA = "f".repeat(40);

let testDb: TestDb;

beforeAll(async () => {
  testDb = await startTestDb();
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(projects);
  await testDb.db.delete(gitAccounts);
});

afterAll(async () => {
  await testDb.stop();
});

interface Setup {
  projectId: string;
  repositoryId: string;
  ticket: { id: string; number: number; title: string };
  reviewId: string;
  mainProject: MirrorProject;
}

async function setup(
  opts: {
    maxRounds?: number;
    branch?: string;
    linked?: boolean;
    reviewer?: boolean;
    reviewerCredentials?: Record<string, string>;
  } = {},
): Promise<Setup> {
  const [account] = await testDb.db
    .insert(gitAccounts)
    .values({
      name: `Principale ${randomUUID()}`,
      provider: "github",
      encryptedCredentials: encrypt(JSON.stringify({ token: "main-token" }), ENCRYPTION_KEY),
    })
    .returning();
  const [reviewer] = opts.reviewer
    ? await testDb.db
        .insert(gitAccounts)
        .values({
          name: `Revisore ${randomUUID()}`,
          provider: "github",
          encryptedCredentials: encrypt(
            JSON.stringify(opts.reviewerCredentials ?? { token: "reviewer-token" }),
            ENCRYPTION_KEY,
          ),
        })
        .returning()
    : [];
  const [project] = await testDb.db
    .insert(projects)
    .values({
      name: "Ciclo",
      slug: `ciclo-${randomUUID()}`,
      ingestionKey: randomUUID(),
      prCorrectionMaxRounds: opts.maxRounds ?? 3,
    })
    .returning();
  const [repository] = await testDb.db
    .insert(repositories)
    .values({
      projectId: project!.id,
      name: "Repo",
      slug: `repo-${randomUUID()}`,
      provider: "github",
      gitAccountId: account!.id,
      repoUrl: "https://example.com/owner/repo",
      defaultBranch: "main",
      ...(reviewer ? { reviewGitAccountId: reviewer.id } : {}),
    })
    .returning();
  const [ticket] = await testDb.db
    .insert(tickets)
    .values({ projectId: project!.id, number: 7, title: "Bug", type: "bug", priority: "high", source: "manual" })
    .returning();
  if (opts.linked !== false) {
    await testDb.db.insert(ticketRepositories).values({
      ticketId: ticket!.id,
      repositoryId: repository!.id,
      branch: opts.branch ?? "stubwise/ticket-7",
      prUrl: "https://example.com/owner/repo/pull/12",
      prState: "open",
      prNumber: 12,
    });
  }
  const [review] = await testDb.db
    .insert(prReviews)
    .values({
      repositoryId: repository!.id,
      prNumber: 12,
      prUrl: "https://example.com/owner/repo/pull/12",
      prTitle: "fix: bug (#7)",
      headSha: FULL_SHA.slice(0, 12),
      ticketId: ticket!.id,
      status: "completed",
      verdict: "request_changes",
      summary: "- manca un test",
    })
    .returning();
  return {
    projectId: project!.id,
    repositoryId: repository!.id,
    ticket: { id: ticket!.id, number: 7, title: "Bug" },
    reviewId: review!.id,
    mainProject: {
      provider: "github",
      repoUrl: "https://example.com/owner/repo",
      defaultBranch: "main",
      credentials: { token: "main-token" },
    },
  };
}

interface Fakes {
  deps: ReviewCycleDeps;
  createPrComment: ReturnType<typeof vi.fn>;
  submitPrReview: ReturnType<typeof vi.fn>;
  setCommitStatus: ReturnType<typeof vi.fn>;
  events: NotificationEvent[];
}

function fakes(): Fakes {
  const createPrComment = vi.fn().mockResolvedValue(undefined);
  const submitPrReview = vi.fn().mockResolvedValue({ status: "submitted" });
  const setCommitStatus = vi.fn().mockResolvedValue(undefined);
  const events: NotificationEvent[] = [];
  return {
    deps: {
      db: testDb.db,
      encryptionKey: ENCRYPTION_KEY,
      getProviderFn: () => ({ createPrComment, submitPrReview, setCommitStatus }),
      publish: async (_db: Db, event: NotificationEvent) => {
        events.push(event);
        return { published: 1, notificationIds: [] };
      },
    },
    createPrComment,
    submitPrReview,
    setCommitStatus,
    events,
  };
}

function input(s: Setup, overrides: Partial<AfterReviewCompletedInput> = {}): AfterReviewCompletedInput {
  return {
    job: {
      repositoryId: s.repositoryId,
      prNumber: 12,
      prUrl: "https://example.com/owner/repo/pull/12",
      prTitle: "fix: bug (#7)",
      prBody: "",
      sourceBranch: "stubwise/ticket-7",
      targetBranch: "main",
      headSha: FULL_SHA.slice(0, 12),
    },
    reviewId: s.reviewId,
    // Lo sha completo risolto UNA volta alla partenza (run-review.ts).
    fullSha: FULL_SHA,
    mirrorProject: s.mainProject,
    projectId: s.projectId,
    repositoryName: "Repo",
    ticket: s.ticket,
    verdict: "request_changes",
    reviewBody: "🔎 **PR Review** — changes requested\n\n- manca un test",
    prSummary: null,
    lang: "en",
    ...overrides,
  };
}

async function seedAutoRounds(s: Setup, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await testDb.db.insert(prCorrections).values({
      ticketId: s.ticket.id,
      repositoryId: s.repositoryId,
      prNumber: 12,
      trigger: "review",
      status: "done",
      createdAt: new Date(Date.now() - (n - i) * 60_000),
    });
  }
}

describe("afterReviewCompleted — ciclo", () => {
  it("request_changes sotto il tetto: accoda la correzione automatica, nessuna notifica", async () => {
    const s = await setup();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    const rows = await testDb.db.select().from(prCorrections).where(eq(prCorrections.repositoryId, s.repositoryId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: "review", status: "queued", reviewId: s.reviewId, prNumber: 12 });
    const [job] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.correctionId, rows[0]!.id));
    expect(job?.status).toBe("queued");
    expect(f.events).toHaveLength(0);
  });

  it("al tetto: niente correzione, notifica review.completed con cycle.stopped", async () => {
    const s = await setup({ maxRounds: 2 });
    await seedAutoRounds(s, 2);
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    const open = await testDb.db.select().from(prCorrections).where(eq(prCorrections.status, "queued"));
    expect(open).toHaveLength(0);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ kind: "review.completed", verdict: "request_changes", cycle: { round: 2, max: 2, stopped: true, stoppedReason: "cap" } });
  });

  it("una richiesta umana azzera il conteggio: sotto il tetto si riprende", async () => {
    const s = await setup({ maxRounds: 2 });
    await seedAutoRounds(s, 2);
    // Richiesta umana DOPO i due giri automatici.
    await testDb.db.insert(prCorrections).values({
      ticketId: s.ticket.id,
      repositoryId: s.repositoryId,
      prNumber: 12,
      trigger: "stubwise",
      status: "done",
    });
    expect(await autoRoundsInCurrentSeries(testDb.db, { repositoryId: s.repositoryId, prNumber: 12 })).toBe(0);
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    const queued = await testDb.db.select().from(prCorrections).where(eq(prCorrections.status, "queued"));
    expect(queued).toHaveLength(1);
    expect(f.events).toHaveLength(0);
  });

  it("tetto 0: ciclo automatico spento, notifica come oggi con cycle a zero", async () => {
    const s = await setup({ maxRounds: 0 });
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    expect(await testDb.db.select().from(prCorrections)).toHaveLength(0);
    expect(f.events[0]).toMatchObject({ kind: "review.completed", cycle: { round: 0, max: 0, stopped: false } });
  });

  it("approve: notifica con il giro corrente, nessuna correzione", async () => {
    const s = await setup({ maxRounds: 3 });
    await seedAutoRounds(s, 1);
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s, { verdict: "approve" }));

    expect(await testDb.db.select().from(prCorrections).where(eq(prCorrections.status, "queued"))).toHaveLength(0);
    expect(f.events[0]).toMatchObject({ kind: "review.completed", verdict: "approve", cycle: { round: 1, max: 3, stopped: false } });
  });

  it("approve con una pending in attesa: parte la pending, e l'approvazione si notifica", async () => {
    const s = await setup({ maxRounds: 3 });
    const [pending] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId: s.ticket.id, repositoryId: s.repositoryId, prNumber: 12, trigger: "provider", status: "pending" })
      .returning();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s, { verdict: "approve" }));

    const rows = await testDb.db.select().from(prCorrections).where(eq(prCorrections.repositoryId, s.repositoryId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: pending!.id, status: "queued", trigger: "provider" });
    const jobs = await testDb.db.select().from(aiJobs).where(eq(aiJobs.correctionId, pending!.id));
    expect(jobs).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ kind: "review.completed", verdict: "approve", cycle: { stopped: false } });
  });

  it("approve: la pending di un'ALTRA PR del ticket NON parte qui (la promuove il tick)", async () => {
    const s = await setup({ maxRounds: 3 });
    const [altra] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId: s.ticket.id, repositoryId: s.repositoryId, prNumber: 13, trigger: "provider", status: "pending" })
      .returning();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s, { verdict: "approve" }));

    const [after] = await testDb.db.select().from(prCorrections).where(eq(prCorrections.id, altra!.id));
    expect(after!.status).toBe("pending");
  });

  it("B chiede modifiche mentre A corregge: pending(B, review), promossa alla fine di A", async () => {
    const s = await setup({ maxRounds: 3 });
    // A = la PR 13 dello stesso ticket, con una correzione in lavorazione.
    const [a] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId: s.ticket.id, repositoryId: s.repositoryId, prNumber: 13, trigger: "review", status: "queued" })
      .returning();
    const [aJob] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId: s.ticket.id, status: "fixing", correctionId: a!.id })
      .returning();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s)); // B = la PR 12, request_changes

    const [b] = await testDb.db
      .select()
      .from(prCorrections)
      .where(and(eq(prCorrections.repositoryId, s.repositoryId), eq(prCorrections.prNumber, 12)));
    expect(b).toMatchObject({ trigger: "review", status: "pending", reviewId: s.reviewId });
    expect(f.events).toHaveLength(0); // il ciclo non è finito: nessuna notifica

    // Fine della correzione di A, come la chiude runCorrection (C8).
    await testDb.db.update(aiJobs).set({ status: "pr_opened" }).where(eq(aiJobs.id, aJob!.id));
    await completeCorrection(testDb.db, a!.id);
    expect(await promotePendingForTicket(testDb.db, s.ticket.id)).toEqual([b!.id]);
    const [bJob] = await testDb.db.select().from(aiJobs).where(eq(aiJobs.correctionId, b!.id));
    expect(bJob).toMatchObject({ status: "queued", manualTrigger: false });
  });

  it("approve con un giro AUTOMATICO in fila (pending review): annullato, non promosso, nessun job", async () => {
    const s = await setup({ maxRounds: 3 });
    const [auto] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId: s.ticket.id, repositoryId: s.repositoryId, prNumber: 12, trigger: "review", status: "pending" })
      .returning();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s, { verdict: "approve" }));

    const [after] = await testDb.db.select().from(prCorrections).where(eq(prCorrections.id, auto!.id));
    expect(after!.status).toBe("cancelled");
    expect(await testDb.db.select().from(aiJobs).where(eq(aiJobs.correctionId, auto!.id))).toHaveLength(0);
    expect(f.events[0]).toMatchObject({ kind: "review.completed", verdict: "approve" });
  });

  it("approve con una richiesta UMANA in fila (pending stubwise): promossa col suo job", async () => {
    const s = await setup({ maxRounds: 3 });
    const [human] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId: s.ticket.id, repositoryId: s.repositoryId, prNumber: 12, trigger: "stubwise", status: "pending" })
      .returning();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s, { verdict: "approve" }));

    const [after] = await testDb.db.select().from(prCorrections).where(eq(prCorrections.id, human!.id));
    expect(after!.status).toBe("queued");
    expect(await testDb.db.select().from(aiJobs).where(eq(aiJobs.correctionId, human!.id))).toHaveLength(1);
  });

  it("al tetto la notifica di stop si RIPETE a ogni review successiva (è un fatto nuovo)", async () => {
    const s = await setup({ maxRounds: 2 });
    await seedAutoRounds(s, 2);
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));
    await afterReviewCompleted(f.deps, input(s, { job: { ...input(s).job, headSha: "e".repeat(40) } }));

    expect(f.events).toHaveLength(2);
    for (const event of f.events) {
      expect(event).toMatchObject({ kind: "review.completed", cycle: { round: 2, max: 2, stopped: true, stoppedReason: "cap" } });
    }
  });

  it("tetto abbassato a metà serie: l'evento porta il round REALE e il max nuovo", async () => {
    const s = await setup({ maxRounds: 2 });
    await seedAutoRounds(s, 3);
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    expect(f.events[0]).toMatchObject({ kind: "review.completed", cycle: { round: 3, max: 2, stopped: true, stoppedReason: "cap" } });
  });

  it("B al tetto mentre A corregge: nessuna pending, notifica di stop", async () => {
    const s = await setup({ maxRounds: 2 });
    await seedAutoRounds(s, 2);
    const [a] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId: s.ticket.id, repositoryId: s.repositoryId, prNumber: 13, trigger: "review", status: "queued" })
      .returning();
    await testDb.db.insert(aiJobs).values({ ticketId: s.ticket.id, status: "fixing", correctionId: a!.id });
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    const onB = await testDb.db
      .select()
      .from(prCorrections)
      .where(and(eq(prCorrections.repositoryId, s.repositoryId), eq(prCorrections.prNumber, 12)));
    expect(onB.filter((r) => r.status === "pending" || r.status === "queued")).toHaveLength(0);
    expect(f.events[0]).toMatchObject({ kind: "review.completed", cycle: { round: 2, max: 2, stopped: true, stoppedReason: "cap" } });
  });

  it("request_changes sotto il tetto con una pending su un'ALTRA PR: parte il giro automatico, la pending aspetta la sua fine", async () => {
    const s = await setup({ maxRounds: 3 });
    const [altra] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId: s.ticket.id, repositoryId: s.repositoryId, prNumber: 13, trigger: "provider", status: "pending" })
      .returning();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    const rows = await testDb.db.select().from(prCorrections).where(eq(prCorrections.repositoryId, s.repositoryId));
    expect(rows.find((r) => r.id === altra!.id)!.status).toBe("pending");
    expect(rows.find((r) => r.prNumber === 12)).toMatchObject({ trigger: "review", status: "queued" });
  });

  it("approve con una correzione già in coda: niente promozione, solo la notifica", async () => {
    const s = await setup({ maxRounds: 3 });
    await testDb.db.insert(prCorrections).values([
      { ticketId: s.ticket.id, repositoryId: s.repositoryId, prNumber: 12, trigger: "stubwise", status: "queued" },
      { ticketId: s.ticket.id, repositoryId: s.repositoryId, prNumber: 12, trigger: "provider", status: "pending" },
    ]);
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s, { verdict: "approve" }));

    const statuses = (await testDb.db.select().from(prCorrections).where(eq(prCorrections.repositoryId, s.repositoryId)))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual(["pending", "queued"]);
    expect(f.events[0]).toMatchObject({ kind: "review.completed", verdict: "approve" });
  });

  it("una richiesta umana in attesa vince sulla correzione automatica", async () => {
    const s = await setup();
    const [pending] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId: s.ticket.id, repositoryId: s.repositoryId, prNumber: 12, trigger: "provider", status: "pending" })
      .returning();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    const rows = await testDb.db.select().from(prCorrections).where(eq(prCorrections.repositoryId, s.repositoryId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: pending!.id, status: "queued", trigger: "provider" });
    expect(f.events).toHaveLength(0);
  });

  it("una correzione già in coda (richiesta durante la review): non accoda niente", async () => {
    const s = await setup();
    await testDb.db
      .insert(prCorrections)
      .values({ ticketId: s.ticket.id, repositoryId: s.repositoryId, prNumber: 12, trigger: "stubwise", status: "queued" });
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    const rows = await testDb.db.select().from(prCorrections).where(eq(prCorrections.repositoryId, s.repositoryId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger).toBe("stubwise");
  });

  it("PR scritta da una persona: nessuna correzione, notifica come oggi SENZA cycle", async () => {
    const s = await setup({ linked: false });
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s, { job: { ...input(s).job, sourceBranch: "feature/login" } }));

    expect(await testDb.db.select().from(prCorrections)).toHaveLength(0);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).not.toHaveProperty("cycle");
  });

  it("branch stubwise/ticket-N ma nessuna PR di Stubwise collegata al ticket: nessuna correzione", async () => {
    const s = await setup({ linked: false });
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    expect(await testDb.db.select().from(prCorrections)).toHaveLength(0);
  });
});

describe("afterReviewCompleted — pubblicazione e status", () => {
  it("senza account revisore: commento con l'account principale, nessuno stato vero della PR", async () => {
    const s = await setup();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    expect(f.createPrComment).toHaveBeenCalledTimes(1);
    const [project, prNumber, body] = f.createPrComment.mock.calls[0] as [MirrorProject, number, string];
    expect(project.credentials.token).toBe("main-token");
    expect(prNumber).toBe(12);
    expect(body).toContain(`\`${FULL_SHA.slice(0, 7)}\``);
    expect(f.submitPrReview).not.toHaveBeenCalled();
  });

  it("con account revisore: submitPrReview con le SUE credenziali, e nessun commento doppio", async () => {
    const s = await setup({ reviewer: true });
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    expect(f.submitPrReview).toHaveBeenCalledTimes(1);
    const [project, prNumber, verdict, body] = f.submitPrReview.mock.calls[0] as [MirrorProject, number, string, string];
    expect(project.credentials.token).toBe("reviewer-token");
    expect(project.repoUrl).toBe(s.mainProject.repoUrl);
    expect([prNumber, verdict]).toEqual([12, "request_changes"]);
    expect(body).toContain("manca un test");
    expect(f.createPrComment).not.toHaveBeenCalled();
  });

  it("submitPrReview fallisce: ripiega sul commento dell'account principale", async () => {
    const s = await setup({ reviewer: true });
    const f = fakes();
    f.submitPrReview.mockRejectedValue(new Error("403"));

    await afterReviewCompleted(f.deps, input(s));

    expect(f.createPrComment).toHaveBeenCalledTimes(1);
    expect((f.createPrComment.mock.calls[0]![0] as MirrorProject).credentials.token).toBe("main-token");
  });

  // Il commento di ripiego si apre con UNA riga fissa (template i18n) che dice
  // che il verdetto non è stato apposto, con la sola CATEGORIA del motivo:
  // mai il messaggio grezzo (qui contiene un token finto apposta).
  const fallbackCases: Array<{ name: string; err: () => unknown; en: string; it: string }> = [
    {
      name: "permessi (GitProviderError 403)",
      err: () => new GitProviderError("GitHub API error 403: SECRET-TOKEN-xyz", 403, "SECRET-TOKEN-xyz"),
      en: "Verdict not submitted: the reviewer account does not have the required permissions.",
      it: "Verdetto non apposto: l'account revisore non ha i permessi.",
    },
    {
      name: "permessi (GitProviderError 401)",
      err: () => new GitProviderError("Bitbucket API error 401: SECRET-TOKEN-xyz", 401, "SECRET-TOKEN-xyz"),
      en: "Verdict not submitted: the reviewer account does not have the required permissions.",
      it: "Verdetto non apposto: l'account revisore non ha i permessi.",
    },
    {
      name: "permessi (GitProviderError 404, repository privato non visibile)",
      err: () => new GitProviderError("GitHub API error 404: SECRET-TOKEN-xyz", 404, "SECRET-TOKEN-xyz"),
      en: "Verdict not submitted: the reviewer account does not have the required permissions.",
      it: "Verdetto non apposto: l'account revisore non ha i permessi.",
    },
    {
      name: "configurazione (GitHub 422 own pull request)",
      err: () =>
        new GitProviderError(
          "GitHub: review rifiutata (422) SECRET-TOKEN-xyz",
          422,
          "Can not approve your own pull request SECRET-TOKEN-xyz",
        ),
      en: "Verdict not submitted: the reviewer account is the author of the pull request.",
      it: "Verdetto non apposto: l'account revisore è l'autore della pull request.",
    },
    {
      name: "rete (fetch failed)",
      err: () => new TypeError("fetch failed", { cause: Object.assign(new Error("SECRET-TOKEN-xyz"), { code: "ECONNREFUSED" }) }),
      en: "Verdict not submitted: the reviewer account could not be reached.",
      it: "Verdetto non apposto: l'account revisore non è raggiungibile.",
    },
    {
      name: "rete (timeout)",
      err: () => Object.assign(new Error("This operation was aborted SECRET-TOKEN-xyz"), { name: "AbortError" }),
      en: "Verdict not submitted: the reviewer account could not be reached.",
      it: "Verdetto non apposto: l'account revisore non è raggiungibile.",
    },
    {
      name: "altro (GitProviderError 500)",
      err: () => new GitProviderError("GitHub API error 500: SECRET-TOKEN-xyz", 500, "SECRET-TOKEN-xyz"),
      en: "Verdict not submitted: provider error.",
      it: "Verdetto non apposto: errore del provider.",
    },
  ];

  it.each(fallbackCases)("ripiego per $name: la prima riga dice la categoria, mai l'errore grezzo", async (c) => {
    for (const lang of ["en", "it"] as const) {
      const s = await setup({ reviewer: true });
      const f = fakes();
      f.submitPrReview.mockRejectedValue(c.err());

      await afterReviewCompleted(f.deps, input(s, { lang }));

      expect(f.createPrComment).toHaveBeenCalledTimes(1);
      const body = f.createPrComment.mock.calls[0]![2] as string;
      expect(body.split("\n")[0]).toBe(lang === "en" ? c.en : c.it);
      expect(body).toContain("manca un test");
      expect(body).not.toContain("SECRET-TOKEN");
      expect(body).not.toContain("main-token");
      expect(body).not.toContain("reviewer-token");
    }
  });

  it("senza account revisore il commento NON porta la riga del verdetto non apposto", async () => {
    const s = await setup();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    const body = f.createPrComment.mock.calls[0]![2] as string;
    expect(body.startsWith("🔎 **PR Review**")).toBe(true);
    expect(body).not.toContain("Verdict not submitted");
  });

  it("verdictFailureReason: i casi puri", () => {
    expect(verdictFailureReason(new GitProviderError("x", 403, ""))).toBe("permissions");
    expect(verdictFailureReason(new GitProviderError("x", 401, ""))).toBe("permissions");
    // 404: il revisore non VEDE il repository privato — è un permesso.
    expect(verdictFailureReason(new GitProviderError("x", 404, ""))).toBe("permissions");
    // 422 GitHub «own pull request»: revisore = autore, è configurazione.
    expect(
      verdictFailureReason(
        new GitProviderError("x", 422, '{"message":"Can not request changes on your own pull request"}'),
      ),
    ).toBe("configuration");
    expect(verdictFailureReason(new GitProviderError("x", 422, '{"message":"Validation Failed"}'))).toBe("other");
    expect(verdictFailureReason(new GitProviderError("x", 400, ""))).toBe("other");
    expect(verdictFailureReason(new GitProviderError("x", 0, ""))).toBe("other");
    expect(verdictFailureReason(new TypeError("fetch failed"))).toBe("network");
    expect(verdictFailureReason(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe("network");
    expect(verdictFailureReason(new Error("x", { cause: { code: "ETIMEDOUT" } }))).toBe("network");
    // un "403" nel messaggio di un errore generico non è un permesso
    expect(verdictFailureReason(new Error("403"))).toBe("other");
    expect(verdictFailureReason("boom")).toBe("other");
  });

  // Con il VERO BitbucketProvider (solo `fetch` finto): è l'ordine interno di
  // submitPrReview (verdetto prima del commento, B8) a garantire che il
  // ripiego non duplichi il testo, e un doppio di submitPrReview non lo
  // eserciterebbe. Le credenziali hanno l'email: senza, projectRestAuthHeader
  // lancerebbe PRIMA di ogni richiesta e il test passerebbe per il motivo
  // sbagliato.
  it("il verdetto fallisce su Bitbucket → testo pubblicato UNA volta, dal ripiego", async () => {
    const s = await setup({
      reviewer: true,
      reviewerCredentials: { email: "rev@example.com", token: "reviewer-token" },
    });
    const f = fakes();
    const PR = "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/12";
    const fetchImpl = vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
      const key = `${init?.method} ${String(url)}`;
      if (key === `POST ${PR}/request-changes`) return Promise.resolve(new Response("merged", { status: 400 }));
      if (key === `POST ${PR}/comments`) return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const bitbucket = new BitbucketProvider({ fetchImpl });
    const mainBitbucket: MirrorProject = {
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/ws/repo",
      defaultBranch: "main",
      credentials: { email: "main@example.com", token: "main-token" },
    };
    const deps: ReviewCycleDeps = { ...f.deps, getProviderFn: () => bitbucket };

    await afterReviewCompleted(deps, input(s, { mirrorProject: mainBitbucket }));

    // il verdetto è stato tentato, con l'account revisore
    const verdicts = fetchImpl.mock.calls.filter(
      ([url, init]) => String(url) === `${PR}/request-changes` && (init as RequestInit).method === "POST",
    );
    expect(verdicts).toHaveLength(1);
    // il testo è uscito UNA volta, ed è quello del ripiego (account principale)
    const comments = fetchImpl.mock.calls.filter(
      ([url, init]) => String(url) === `${PR}/comments` && (init as RequestInit).method === "POST",
    );
    expect(comments).toHaveLength(1);
    expect(((comments[0]![1] as RequestInit).headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("main@example.com:main-token").toString("base64")}`,
    );
    // e il testo del ripiego dice che il verdetto non è stato apposto (un 400
    // non è un problema di permessi né di rete: errore del provider)
    const sent = JSON.parse(String((comments[0]![1] as RequestInit).body)) as { content: { raw: string } };
    expect(sent.content.raw.split("\n")[0]).toBe("Verdict not submitted: provider error.");
  });

  // Bitbucket: il verdetto è apposto (POST riuscito), poi il commento del
  // REVISORE fallisce. Il ripiego pubblica il testo dall'account principale,
  // ma la sua prima riga non può dire «verdetto non apposto»: il verdetto c'è.
  it("verdetto apposto e commento del revisore fallito su Bitbucket → nessuna riga «non apposto»", async () => {
    const s = await setup({
      reviewer: true,
      reviewerCredentials: { email: "rev@example.com", token: "reviewer-token" },
    });
    const f = fakes();
    const PR = "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/12";
    const reviewerAuth = `Basic ${Buffer.from("rev@example.com:reviewer-token").toString("base64")}`;
    const fetchImpl = vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
      const key = `${init?.method} ${String(url)}`;
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      if (key === `POST ${PR}/comments`) {
        return Promise.resolve(
          auth === reviewerAuth
            ? new Response("boom", { status: 500 })
            : new Response(JSON.stringify({ id: 1 }), { status: 201 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ approved: true }), { status: 200 }));
    });
    const bitbucket = new BitbucketProvider({ fetchImpl });
    const mainBitbucket: MirrorProject = {
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/ws/repo",
      defaultBranch: "main",
      credentials: { email: "main@example.com", token: "main-token" },
    };
    const deps: ReviewCycleDeps = { ...f.deps, getProviderFn: () => bitbucket };

    for (const lang of ["en", "it"] as const) {
      fetchImpl.mockClear();
      await afterReviewCompleted(deps, input(s, { mirrorProject: mainBitbucket, lang }));

      const comments = fetchImpl.mock.calls.filter(
        ([url, init]) => String(url) === `${PR}/comments` && (init as RequestInit).method === "POST",
      );
      // il commento del revisore (fallito) e quello di ripiego
      expect(comments).toHaveLength(2);
      const sent = JSON.parse(String((comments[1]![1] as RequestInit).body)) as { content: { raw: string } };
      expect(sent.content.raw).not.toContain("Verdict not submitted");
      expect(sent.content.raw).not.toContain("Verdetto non apposto");
      expect(sent.content.raw.split("\n")[0]).toBe(
        lang === "en"
          ? "The reviewer account submitted the verdict, but its comment could not be published."
          : "Il revisore ha apposto il verdetto, ma il suo commento non è stato pubblicato.",
      );
      expect(sent.content.raw).toContain("manca un test");
    }
  });

  it("status di commit sullo sha COMPLETO risolto alla partenza, legato al branch sorgente", async () => {
    const s = await setup();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    expect(f.setCommitStatus).toHaveBeenCalledWith(
      s.mainProject,
      FULL_SHA,
      expect.objectContaining({ state: "failure", key: "stubwise-review", refname: "stubwise/ticket-7" }),
    );
  });

  it("status e commento che falliscono non fermano il ciclo", async () => {
    const s = await setup();
    const f = fakes();
    f.setCommitStatus.mockRejectedValue(new Error("boom"));
    f.createPrComment.mockRejectedValue(new Error("boom"));

    await afterReviewCompleted(f.deps, input(s));

    expect(await testDb.db.select().from(prCorrections).where(eq(prCorrections.status, "queued"))).toHaveLength(1);
  });

  it("sha non risolto alla partenza: nessuno status, il ciclo va avanti", async () => {
    const s = await setup();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s, { fullSha: null }));

    expect(f.setCommitStatus).not.toHaveBeenCalled();
    expect(await testDb.db.select().from(prCorrections).where(eq(prCorrections.status, "queued"))).toHaveLength(1);
  });
});

// SCELTA DIFENSIVA da confermare con B14 §6a: il link dello status parte solo
// verso un'istanza https raggiungibile da fuori.
describe("afterReviewCompleted — link dello status di commit (B14 §6a)", () => {
  it("URL pubblico https: lo status porta il link al ticket", async () => {
    const s = await setup();
    const f = fakes();

    await afterReviewCompleted({ ...f.deps, publicUrl: "https://stubwise.example.com/" }, input(s));

    const status = f.setCommitStatus.mock.calls[0]![2] as { url?: string };
    expect(status.url).toBe(`https://stubwise.example.com/tickets/${s.ticket.id}`);
  });

  it("URL pubblico http o localhost: lo status parte SENZA link", async () => {
    for (const publicUrl of ["http://stubwise.example.com", "https://localhost:3000", "https://127.0.0.1"]) {
      const s = await setup();
      const f = fakes();

      await afterReviewCompleted({ ...f.deps, publicUrl }, input(s));

      expect(f.setCommitStatus).toHaveBeenCalledTimes(1);
      expect(f.setCommitStatus.mock.calls[0]![2]).not.toHaveProperty("url");
      await testDb.db.delete(projects);
    }
  });

  it("commitStatusTargetUrl: i casi puri", () => {
    expect(commitStatusTargetUrl(undefined, "t1")).toBeUndefined();
    expect(commitStatusTargetUrl("", "t1")).toBeUndefined();
    expect(commitStatusTargetUrl("http://s.example.com", "t1")).toBeUndefined();
    expect(commitStatusTargetUrl("https://LOCALHOST", "t1")).toBeUndefined();
    expect(commitStatusTargetUrl("https://[::1]:8443", "t1")).toBeUndefined();
    expect(commitStatusTargetUrl("https://s.example.com", "t1")).toBe("https://s.example.com/tickets/t1");
  });
});

// SCELTA DIFENSIVA: un 409 sul verdetto Bitbucket è «già in quello stato», non
// un errore — niente ripiego, niente testo doppio. Dal vivo (B14 T21) un
// verdetto ripetuto risponde 200, mai 409: il ramo oggi non scatta, è innocuo.
describe("afterReviewCompleted — verdetto già in quello stato (B14 §7a)", () => {
  it("Bitbucket 409 sul verdetto: il commento del revisore esce, nessun ripiego", async () => {
    const s = await setup({
      reviewer: true,
      reviewerCredentials: { email: "rev@example.com", token: "reviewer-token" },
    });
    const f = fakes();
    const PR = "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/12";
    const fetchImpl = vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
      const key = `${init?.method} ${String(url)}`;
      if (key === `POST ${PR}/request-changes`) return Promise.resolve(new Response("already", { status: 409 }));
      if (key === `POST ${PR}/comments`) return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const bitbucket = new BitbucketProvider({ fetchImpl });
    const mainBitbucket: MirrorProject = {
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/ws/repo",
      defaultBranch: "main",
      credentials: { email: "main@example.com", token: "main-token" },
    };
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    let logLines: string[];
    try {
      await afterReviewCompleted({ ...f.deps, getProviderFn: () => bitbucket }, input(s, { mirrorProject: mainBitbucket }));
    } finally {
      logLines = logs.mock.calls.map(([line]) => String(line));
      logs.mockRestore();
    }

    const comments = fetchImpl.mock.calls.filter(
      ([url, init]) => String(url) === `${PR}/comments` && (init as RequestInit).method === "POST",
    );
    expect(comments).toHaveLength(1);
    // Il commento è del REVISORE: nessun ripiego sull'account principale.
    expect(((comments[0]![1] as RequestInit).headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("rev@example.com:reviewer-token").toString("base64")}`,
    );
    // Il log dice perché, con un estratto della risposta (senza credenziali).
    expect(logLines.some((line) => line.includes("già in stato") && line.includes('409: "already"'))).toBe(true);
  });
});
