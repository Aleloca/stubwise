import { randomBytes } from "node:crypto";
import { agentSessions, aiJobs, planDigest, prCorrections, prReviews, projectDecisions, ticketRepositories, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedRepositoryInProject, startTestDb } from "@stubwise/db/testing";
import { taskWorkViewSchema, type TaskWorkView } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * `GET /api/tasks/:id/work` esteso (integrazione area 3, fetta 3a): le
 * sessioni di lavoro della task (`runs`, dalla più vecchia, col piano e la
 * sessione da cui leggere gli eventi), gli eventi e i fatti delle PR, le
 * decisioni sui piani, e le AZIONI possibili calcolate dal server coi permessi
 * di chi guarda (`allowed` | `forbidden` | `unavailable`): il client le legge,
 * non le deduce. I test sono a più utenti sugli STESSI dati.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let repositoryId: string;
type U = { id: string; headers: { cookie: string } };
let lead: U;
let developer: U;
let viewer: U;
let contributor: U;
let n = 0;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
  ({ projectId, repositoryId } = await seedRepository(testDb.db));
  lead = await createUserWithSession(app, "lead@example.com");
  developer = await createUserWithSession(app, "dev@example.com");
  viewer = await createUserWithSession(app, "viewer@example.com");
  contributor = await createUserWithSession(app, "contrib@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, developer.id, "developer");
  await addMember(app, projectId, viewer.id, "viewer");
  await addMember(app, projectId, contributor.id, "contributor");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function task(requestedByUserId?: string): Promise<string> {
  n += 1;
  const [row] = await testDb.db
    .insert(tickets)
    .values({ projectId, number: 1000 + n, title: `T${n}`, type: "bug", priority: "medium", source: "manual", ...(requestedByUserId ? { requestedByUserId } : {}) })
    .returning({ id: tickets.id });
  return row!.id;
}

const minutes = (m: number) => new Date(Date.UTC(2026, 10, 10, 9, m));

async function work(ticketId: string, who: U | "admin" = "admin"): Promise<TaskWorkView> {
  const cookie = who === "admin" ? users.adminCookie : who.headers.cookie;
  const res = await app.inject({ method: "GET", url: `/api/tasks/${ticketId}/work`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return taskWorkViewSchema.parse(res.json());
}

async function openPr(ticketId: string, number = 7) {
  const [t] = await testDb.db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, ticketId));
  await testDb.db.insert(ticketRepositories).values({
    ticketId,
    repositoryId,
    // Il branch del ticket stesso: una PR di Stubwise, correggibile (`isCorrectablePr`).
    branch: `stubwise/ticket-${t!.number}`,
    prUrl: `https://github.com/acme/shop/pull/${number}`,
    prNumber: number,
    prState: "open",
  });
}

describe("runs: le sessioni di lavoro della task", () => {
  it("dalla più vecchia; stato ed esito del prototipo; il piano in attesa; la sessione da cui leggere gli eventi", async () => {
    const t = await task();
    const [old] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId: t, status: "failed", createdAt: minutes(1), failureSummary: "Test rossi", requestedByUserId: lead.id })
      .returning({ id: aiJobs.id });
    const [cur] = await testDb.db
      .insert(aiJobs)
      .values({
        ticketId: t,
        status: "awaiting_plan_approval",
        createdAt: minutes(5),
        planText: "## Piano",
        planSummary: "Tre passi",
        requestedByUserId: developer.id,
      })
      .returning({ id: aiJobs.id });
    const [session] = await testDb.db
      .insert(agentSessions)
      .values({ ownerKey: `ai_job:${cur!.id}`, kind: "ai_job", title: "Lavoro", aiJobId: cur!.id, ticketId: t, projectId })
      .returning({ id: agentSessions.id });
    const w = await work(t);
    expect(w.runs.map((r) => r.id)).toEqual([old!.id, cur!.id]);
    expect(w.runs[0]).toMatchObject({ state: "finished", outcome: "failed", failureSummary: "Test rossi", ownerId: lead.id, sessionId: null });
    expect(w.runs[1]).toMatchObject({
      state: "awaiting_approval",
      outcome: null,
      ownerId: developer.id,
      sessionId: session!.id,
      plan: { text: "## Piano", summary: "Tre passi", status: "pending" },
    });
    expect(w.hiddenRuns).toBe(false);
    // Il riassunto di prima resta.
    expect(w.claude).toBe("awaiting_approval");
  });

  it("lo stato del piano solo da un esito verificabile: undecided senza decisione; approved da una decisione o da un'esecuzione; pre_approved dal digest", async () => {
    const planOf = async (t: string) => (await work(t)).runs.at(-1)!.plan!.status;
    // Fermo (held) o annullato sul gate (skipped) senza decisione: non «approved».
    for (const status of ["held", "skipped", "failed", "queued"] as const) {
      const t = await task();
      await testDb.db.insert(aiJobs).values({ ticketId: t, status, planText: "## P" });
      expect(await planOf(t), status).toBe("undecided");
    }
    // Una decisione approvata PER QUEL job.
    const decided = await task();
    const [job] = await testDb.db.insert(aiJobs).values({ ticketId: decided, status: "failed", planText: "## P" }).returning({ id: aiJobs.id });
    await testDb.db.insert(projectDecisions).values({
      projectId,
      source: "plan_review",
      sourceKey: `plan_review:${job!.id}:1`,
      sourceRef: { jobId: job!.id, mode: "execute" },
      ticketId: decided,
      title: "T",
      decision: "Approvato",
      decidedByUserId: lead.id,
    });
    expect(await planOf(decided)).toBe("approved");
    // Un job che ha eseguito il piano è uscito dal gate.
    const executed = await task();
    await testDb.db.insert(aiJobs).values({ ticketId: executed, status: "pr_opened", planText: "## P" });
    expect(await planOf(executed)).toBe("approved");
    // Una pre-approvazione VALIDA (il digest del piano del job).
    const pre = await task();
    await testDb.db
      .update(tickets)
      .set({ implementationPlan: "## Pre", planApprovedAt: new Date(), planApprovedDigest: planDigest("## Pre") })
      .where(eq(tickets.id, pre));
    await testDb.db.insert(aiJobs).values({ ticketId: pre, status: "queued", planText: "## Pre" });
    expect(await planOf(pre)).toBe("pre_approved");
    // Un digest di un ALTRO piano non vale.
    await testDb.db.update(tickets).set({ planApprovedDigest: planDigest("## Vecchio") }).where(eq(tickets.id, pre));
    expect(await planOf(pre)).toBe("undecided");
  });

  it("chi non ha repos.view non riceve le sessioni (né il piano): hiddenRuns", async () => {
    const t = await task(contributor.id);
    await testDb.db.insert(aiJobs).values({ ticketId: t, status: "awaiting_plan_approval", planText: "## Segreto" });
    const w = await work(t, contributor);
    expect(w.runs).toEqual([]);
    expect(w.hiddenRuns).toBe(true);
    expect(JSON.stringify(w)).not.toContain("Segreto");
  });

  it("le decisioni sui piani dal registro, con l'esito dalla riga (mai dal testo)", async () => {
    const t = await task();
    const [job] = await testDb.db.insert(aiJobs).values({ ticketId: t, status: "fixing" }).returning({ id: aiJobs.id });
    await testDb.db.insert(projectDecisions).values([
      {
        projectId,
        source: "plan_review",
        sourceKey: `plan_review:${job!.id}:1`,
        sourceRef: { jobId: job!.id, mode: "fix" },
        ticketId: t,
        title: "T",
        decision: "Rifiutato: usa Postgres",
        decidedByUserId: lead.id,
        decidedAt: minutes(2),
      },
      {
        projectId,
        source: "plan_review",
        sourceKey: `plan_review:${job!.id}:2`,
        sourceRef: { jobId: job!.id, mode: "execute" },
        ticketId: t,
        title: "T",
        decision: "Approvato",
        decidedByUserId: lead.id,
        decidedAt: minutes(4),
      },
    ]);
    const w = await work(t);
    expect(w.planDecisions.map((d) => d.status)).toEqual(["rejected", "approved"]);
    expect(w.planDecisions[0]).toMatchObject({ decidedById: lead.id, decision: "Rifiutato: usa Postgres" });
  });
});

describe("actions: le calcola il server coi permessi di chi guarda", () => {
  it("nessun lavoro: start allowed per chi ha runs.start, forbidden per chi non ce l'ha; il resto unavailable", async () => {
    const t = await task();
    expect((await work(t, developer)).actions).toEqual({ start: "allowed", relaunch: "unavailable", resume: "unavailable", requestChanges: "unavailable" });
    expect((await work(t, viewer)).actions).toEqual({ start: "forbidden", relaunch: "unavailable", resume: "unavailable", requestChanges: "unavailable" });
  });

  it("lavoro finito: relaunch (allowed/forbidden); lavoro in corso: niente da avviare", async () => {
    const t = await task();
    const [job] = await testDb.db.insert(aiJobs).values({ ticketId: t, status: "failed" }).returning({ id: aiJobs.id });
    expect((await work(t, developer)).actions).toMatchObject({ start: "unavailable", relaunch: "allowed" });
    expect((await work(t, viewer)).actions).toMatchObject({ start: "unavailable", relaunch: "forbidden" });
    await testDb.db.update(aiJobs).set({ status: "fixing" }).where(eq(aiJobs.id, job!.id));
    expect((await work(t, developer)).actions).toMatchObject({ start: "unavailable", relaunch: "unavailable" });
  });

  it("una task review non si avvia; una correzione ferma per budget la riprende solo chi ha plans.approve, e il rilancio sparisce", async () => {
    const review = await task();
    await testDb.db.update(tickets).set({ type: "review" }).where(eq(tickets.id, review));
    expect((await work(review, developer)).actions.start).toBe("unavailable");

    const t = await task();
    await openPr(t, 31);
    const [correction] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId: t, repositoryId, prNumber: 31, trigger: "stubwise", status: "queued" })
      .returning({ id: prCorrections.id });
    await testDb.db.insert(aiJobs).values({ ticketId: t, status: "held", heldReason: "budget", correctionId: correction!.id });
    expect((await work(t, lead)).actions).toMatchObject({ resume: "allowed", relaunch: "unavailable", start: "unavailable" });
    // Developer: ha runs.start ma non plans.approve; per budget la riprende solo un maintainer.
    expect((await work(t, developer)).actions).toMatchObject({ resume: "forbidden", relaunch: "unavailable" });
    expect((await work(t, viewer)).actions.resume).toBe("forbidden");
  });

  it("«Chiedi modifiche»: con una PR di Stubwise aperta e niente in volo; senza permesso forbidden; con un lavoro in corso unavailable", async () => {
    const t = await task();
    await openPr(t, 41);
    const [job] = await testDb.db.insert(aiJobs).values({ ticketId: t, status: "pr_opened" }).returning({ id: aiJobs.id });
    expect((await work(t, developer)).actions.requestChanges).toBe("allowed");
    expect((await work(t, viewer)).actions.requestChanges).toBe("forbidden");
    const w = await work(t, developer);
    expect(w.openPr).toBe(true);
    expect(w.software).toBe(true);
    expect(w.prFacts).toEqual([expect.objectContaining({ repo: "acme/shop", number: 41, branchProtected: false, queued: false })]);
    await testDb.db.update(aiJobs).set({ status: "fixing" }).where(eq(aiJobs.id, job!.id));
    expect((await work(t, developer)).actions.requestChanges).toBe("unavailable");
  });

  it("multi-repo: requestChangesPerPr dice la disponibilità di ogni PR accanto all'aggregato; la review approvata ha la sua data", async () => {
    const t = await task();
    await openPr(t, 51);
    const secondId = await seedRepositoryInProject(testDb.db, projectId);
    // La seconda PR non è di Stubwise (un branch qualunque): non si corregge.
    await testDb.db.insert(ticketRepositories).values({
      ticketId: t,
      repositoryId: secondId,
      branch: "feature/altro",
      prUrl: `https://github.com/acme/web-${n}/pull/52`,
      prNumber: 52,
      prState: "open",
    });
    await testDb.db.insert(aiJobs).values({ ticketId: t, status: "pr_opened" });
    const reviewedAt = new Date("2026-11-10T08:30:00.000Z");
    await testDb.db.insert(prReviews).values({
      repositoryId,
      prNumber: 51,
      prUrl: "https://github.com/acme/shop/pull/51",
      prTitle: "Fix",
      headSha: "abc",
      ticketId: t,
      status: "completed",
      verdict: "approve",
      createdAt: reviewedAt,
      startedAt: reviewedAt,
      finishedAt: reviewedAt,
    });
    const w = await work(t, developer);
    // La prima (di Stubwise) si corregge anche dopo un'approvazione; la seconda no.
    expect(w.actions.requestChanges).toBe("allowed");
    const byNumber = <T extends { number: number }>(xs: T[]) => [...xs].sort((a, b) => a.number - b.number);
    expect(byNumber(w.requestChangesPerPr)).toEqual([
      { repo: "acme/shop", number: 51, availability: "allowed" },
      { repo: `acme/web-${n}`, number: 52, availability: "unavailable" },
    ]);
    expect(w.prFacts.find((f) => f.number === 51)?.review).toMatchObject({ verdict: "approved", at: reviewedAt.toISOString() });
    // Chi non ha corrections.request: forbidden dove lo stato lo consente.
    expect(byNumber((await work(t, viewer)).requestChangesPerPr).map((p) => p.availability)).toEqual(["forbidden", "unavailable"]);
  });

  it("waitsOnViewer: un piano in attesa aspetta chi ha plans.approve, non gli altri", async () => {
    const t = await task();
    await testDb.db.insert(aiJobs).values({ ticketId: t, status: "awaiting_plan_approval", planText: "## P" });
    expect((await work(t, lead)).waitsOnViewer).toBe(true);
    expect((await work(t, developer)).waitsOnViewer).toBe(false);
  });

  it("blocked: un avvio a mano scavalca il budget sul server, quindi null", async () => {
    const t = await task();
    expect((await work(t, developer)).blocked).toBeNull();
  });
});

describe("coerenza: le azioni seguono le rotte d'azione di sempre (area 3, fetta 3b)", () => {
  const post = (url: string, who: U, payload?: object) =>
    app.inject({ method: "POST", url, headers: { cookie: who.headers.cookie }, ...(payload ? { payload } : {}) });

  it("run-ai di chi non può approvare → gate; il developer non approva (403, niente cambia); il lead sì, e /work lo dice", async () => {
    const t = await task();
    await testDb.db.update(tickets).set({ implementationPlan: "## Piano salvato" }).where(eq(tickets.id, t));
    expect((await work(t, developer)).actions.start).toBe("allowed");
    const started = await post(`/api/tickets/${t}/run-ai`, developer, {});
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json()).toMatchObject({ status: "awaiting_plan_approval" });

    const afterStart = await work(t, developer);
    expect(afterStart.actions).toMatchObject({ start: "unavailable", relaunch: "unavailable" });
    expect(afterStart.waitsOnViewer).toBe(false);
    expect((await work(t, lead)).waitsOnViewer).toBe(true);

    // I due divieti dell'operatore: 403 E stato invariato.
    const refused = await post(`/api/tickets/${t}/approve-plan`, developer);
    expect(refused.statusCode).toBe(403);
    expect((await work(t, lead)).runs.at(-1)).toMatchObject({ state: "awaiting_approval", plan: { status: "pending" } });

    const approved = await post(`/api/tickets/${t}/approve-plan`, lead);
    expect(approved.statusCode, approved.body).toBe(202);
    const after = await work(t, lead);
    expect(after.waitsOnViewer).toBe(false);
    expect(after.runs.at(-1)).toMatchObject({ state: "working", plan: { status: "approved" } });
    expect(after.actions).toMatchObject({ start: "unavailable", relaunch: "unavailable" });
  });
});

describe("server vecchio", () => {
  it("una risposta senza i campi nuovi si legge coi default (la sezione degrada, non si rompe)", () => {
    const old = taskWorkViewSchema.parse({ claude: "none", pullRequests: [], webHref: "/tickets/x" });
    expect(old).toMatchObject({
      runs: [],
      prEvents: [],
      prFacts: [],
      planDecisions: [],
      hiddenRuns: false,
      openPr: false,
      waitsOnViewer: false,
      actions: { start: "unavailable", relaunch: "unavailable", resume: "unavailable", requestChanges: "unavailable" },
      blocked: null,
    });
  });
});
