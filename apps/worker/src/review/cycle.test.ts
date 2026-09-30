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
import { BitbucketProvider } from "@stubwise/git";
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
  resolveCommitSha: ReturnType<typeof vi.fn>;
  events: NotificationEvent[];
}

function fakes(): Fakes {
  const createPrComment = vi.fn().mockResolvedValue(undefined);
  const submitPrReview = vi.fn().mockResolvedValue("submitted");
  const setCommitStatus = vi.fn().mockResolvedValue(undefined);
  const resolveCommitSha = vi.fn().mockResolvedValue(FULL_SHA);
  const events: NotificationEvent[] = [];
  return {
    deps: {
      db: testDb.db,
      mirrors: { resolveCommitSha },
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
    resolveCommitSha,
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
    expect(f.events[0]).toMatchObject({ kind: "review.completed", verdict: "request_changes", cycle: { round: 2, max: 2, stopped: true } });
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
    expect(f.events[0]).toMatchObject({ kind: "review.completed", cycle: { round: 2, max: 2, stopped: true } });
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
  });

  it("status di commit sullo sha COMPLETO risolto dal mirror, legato al branch sorgente", async () => {
    const s = await setup();
    const f = fakes();

    await afterReviewCompleted(f.deps, input(s));

    expect(f.resolveCommitSha).toHaveBeenCalledWith(s.mainProject, FULL_SHA.slice(0, 12));
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
    f.resolveCommitSha.mockRejectedValue(new Error("sha sconosciuto"));

    await afterReviewCompleted(f.deps, input(s));

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

// SCELTA DIFENSIVA da confermare con B14 §7a: un 409 sul verdetto Bitbucket è
// «già in quello stato», non un errore — niente ripiego, niente testo doppio.
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
    expect(logLines.some((line) => line.includes("già in stato"))).toBe(true);
  });
});
