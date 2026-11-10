import { randomBytes } from "node:crypto";
import { agentQuestions, agentSessions, aiJobs, comments, notifications, prCorrections, ticketFollowers, ticketRepositories, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { taskWorkViewSchema } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * «Annulla il lavoro» (integrazione area 3, fetta 3b, decisione del
 * maintainer del 10 nov 2026, opzione A): chiude SUBITO un job PARCHEGGIATO
 * (in coda, fermo, sul gate del piano, su una domanda: nessun processo vivo),
 * per chi ha `runs.start`. Job e correzione si chiudono INSIEME; PR e branch
 * non si toccano; un commento di sistema da template. Su un job in esecuzione
 * 409 `run_in_progress` (prima «Ferma»), senza lavoro vivo 409
 * `nothing_to_cancel`.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;
let repositoryId: string;
type U = { id: string; headers: { cookie: string } };
let developer: U;
let viewer: U;
let lead: U;
let n = 0;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  await seedUsers(app);
  ({ projectId, repositoryId } = await seedRepository(testDb.db));
  developer = await createUserWithSession(app, "dev-c@example.com");
  viewer = await createUserWithSession(app, "viewer-c@example.com");
  await addMember(app, projectId, developer.id, "developer");
  await addMember(app, projectId, viewer.id, "viewer");
  lead = await createUserWithSession(app, "lead-c@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function taskWithJob(status: (typeof aiJobs.$inferInsert)["status"], extra: Partial<typeof aiJobs.$inferInsert> = {}) {
  n += 1;
  const [t] = await testDb.db
    .insert(tickets)
    .values({ projectId, number: 4000 + n, title: `T${n}`, type: "bug", priority: "medium", source: "manual" })
    .returning({ id: tickets.id, number: tickets.number });
  const [job] = await testDb.db.insert(aiJobs).values({ ticketId: t!.id, status, ...extra }).returning({ id: aiJobs.id });
  return { ticketId: t!.id, number: t!.number, jobId: job!.id };
}

const cancel = (ticketId: string, who: U) =>
  app.inject({ method: "POST", url: `/api/tasks/${ticketId}/cancel-run`, headers: { cookie: who.headers.cookie } });
const jobStatus = async (jobId: string) =>
  (await testDb.db.select({ status: aiJobs.status, finishedAt: aiJobs.finishedAt }).from(aiJobs).where(eq(aiJobs.id, jobId)))[0]!;
const systemComments = (ticketId: string) =>
  testDb.db.select({ body: comments.body }).from(comments).where(and(eq(comments.ticketId, ticketId), eq(comments.authorType, "system")));

describe("POST /api/tasks/:id/cancel-run", () => {
  it("annulla un job parcheggiato (coda, fermo, gate, domanda): skipped, finito, commento di sistema; /work non lo dà più in corso", async () => {
    for (const status of ["queued", "held", "awaiting_plan_approval", "awaiting_input"] as const) {
      const { ticketId, jobId } = await taskWithJob(status, { planText: status === "awaiting_plan_approval" ? "## P" : null });
      const res = await cancel(ticketId, developer);
      expect(res.statusCode, `${status}: ${res.body}`).toBe(200);
      const job = await jobStatus(jobId);
      expect(job.status).toBe("skipped");
      expect(job.finishedAt).not.toBeNull();
      const notes = await systemComments(ticketId);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.body).toContain("dev-c@example.com");
      const work = taskWorkViewSchema.parse(res.json());
      expect(work.runs.at(-1)).toMatchObject({ state: "finished", outcome: "stopped" });
      expect(work.actions.relaunch).toBe("allowed");
    }
  });

  it("dopo l'annullamento le notifiche sono handled (da chi ha annullato) e la domanda non è più aperta, distinta da una risposta", async () => {
    const { ticketId, jobId } = await taskWithJob("awaiting_input");
    const [q] = await testDb.db
      .insert(agentQuestions)
      .values({ jobId, ticketId, round: 1, question: "Quale database?", options: [{ label: "A" }] })
      .returning({ id: agentQuestions.id });
    const card = (kind: "job.awaiting_input" | "job.plan_review" | "job.failed") => ({
      userId: developer.id,
      projectId,
      ticketId,
      jobId,
      kind,
      event: { kind },
    });
    await testDb.db.insert(notifications).values([card("job.awaiting_input"), card("job.plan_review"), card("job.failed")]);
    expect((await cancel(ticketId, developer)).statusCode).toBe(200);
    const rows = await testDb.db
      .select({ kind: notifications.kind, status: notifications.status, by: notifications.handledByUserId })
      .from(notifications)
      .where(eq(notifications.jobId, jobId));
    expect(rows.find((r) => r.kind === "job.awaiting_input")).toMatchObject({ status: "handled", by: developer.id });
    expect(rows.find((r) => r.kind === "job.plan_review")).toMatchObject({ status: "handled", by: developer.id });
    // Un'altra notifica dello stesso job (il fallimento di ieri) non si tocca.
    expect(rows.find((r) => r.kind === "job.failed")).toMatchObject({ status: "open" });
    const [question] = await testDb.db.select().from(agentQuestions).where(eq(agentQuestions.id, q!.id));
    expect(question!.cancelledAt).not.toBeNull();
    expect(question!.answeredAt).toBeNull();
    expect(question!.answer).toBeNull();
  });

  it("nel dettaglio della sessione la domanda annullata si legge cancelled, non risposta né da rispondere", async () => {
    const { ticketId, jobId } = await taskWithJob("awaiting_input");
    await testDb.db.insert(agentQuestions).values({ jobId, ticketId, round: 1, question: "Q?", options: [{ label: "A" }] });
    const [session] = await testDb.db
      .insert(agentSessions)
      .values({ ownerKey: `ai_job:${jobId}`, kind: "ai_job", title: "Lavoro", aiJobId: jobId, ticketId, projectId })
      .returning({ id: agentSessions.id });
    expect((await cancel(ticketId, developer)).statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/api/agent-sessions/${session!.id}`, headers: { cookie: developer.headers.cookie } });
    expect(detail.statusCode, detail.body).toBe(200);
    expect((detail.json() as { questions: unknown[] }).questions).toEqual([
      expect.objectContaining({ answered: false, cancelled: true, canAnswer: false }),
    ]);
  });

  it("un evento nella storia del ticket (run_cancelled, con chi) e ticket.activity ai follower, col change come dato", async () => {
    const { ticketId, jobId } = await taskWithJob("held");
    await testDb.db.insert(ticketFollowers).values({ ticketId, userId: viewer.id });
    expect((await cancel(ticketId, developer)).statusCode).toBe(200);
    const [job] = await testDb.db
      .select({ at: aiJobs.cancelRequestedAt, by: aiJobs.cancelRequestedByUserId })
      .from(aiJobs)
      .where(eq(aiJobs.id, jobId));
    expect(job).toMatchObject({ by: developer.id });
    expect(job!.at).not.toBeNull();
    const history = await app.inject({ method: "GET", url: `/api/tickets/${ticketId}/history`, headers: { cookie: developer.headers.cookie } });
    expect(history.statusCode, history.body).toBe(200);
    expect((history.json() as { events: { kind: string; actor: unknown }[] }).events).toContainEqual(
      expect.objectContaining({ kind: "run_cancelled", actor: { type: "user", name: "dev-c@example.com" } }),
    );
    const cards = await testDb.db
      .select({ userId: notifications.userId, event: notifications.event })
      .from(notifications)
      .where(and(eq(notifications.ticketId, ticketId), eq(notifications.kind, "ticket.activity")));
    expect(cards).toEqual([expect.objectContaining({ userId: viewer.id, event: expect.objectContaining({ change: "run_cancelled", summary: "" }) })]);
  });

  it("chi non ha runs.start → 403 e niente cambia", async () => {
    const { ticketId, jobId } = await taskWithJob("held");
    expect((await cancel(ticketId, viewer)).statusCode).toBe(403);
    expect((await jobStatus(jobId)).status).toBe("held");
    expect(await systemComments(ticketId)).toHaveLength(0);
  });

  it("un job in esecuzione (3b.1-bis): la richiesta si registra (chi, quando) e il job resta al worker; /work dice cancelRequested; ripeterla non cambia niente", async () => {
    for (const status of ["triaging", "fixing"] as const) {
      const { ticketId, jobId } = await taskWithJob(status);
      const res = await cancel(ticketId, developer);
      expect(res.statusCode, `${status}: ${res.body}`).toBe(202);
      expect(taskWorkViewSchema.parse(res.json()).runs.at(-1)).toMatchObject({ cancelRequested: true, state: "working" });
      const [row] = await testDb.db
        .select({ status: aiJobs.status, at: aiJobs.cancelRequestedAt, by: aiJobs.cancelRequestedByUserId })
        .from(aiJobs)
        .where(eq(aiJobs.id, jobId));
      // Lo chiude il worker: il server non tocca lo stato di un job che non è suo.
      expect(row).toMatchObject({ status, by: developer.id });
      expect(row!.at).not.toBeNull();
      expect(await systemComments(ticketId)).toHaveLength(0);
      // La seconda volta: stessa richiesta, stessa data.
      const again = await cancel(ticketId, developer);
      expect(again.statusCode).toBe(202);
      const [same] = await testDb.db.select({ at: aiJobs.cancelRequestedAt }).from(aiJobs).where(eq(aiJobs.id, jobId));
      expect(same!.at!.getTime()).toBe(row!.at!.getTime());
    }
  });

  it("un job concluso o nessun job → 409 nothing_to_cancel; niente cambia", async () => {
    for (const status of ["pr_opened", "failed", "skipped"] as const) {
      const { ticketId, jobId } = await taskWithJob(status);
      const res = await cancel(ticketId, developer);
      expect(res.statusCode, status).toBe(409);
      expect(res.json()).toMatchObject({ code: "nothing_to_cancel" });
      expect((await jobStatus(jobId)).status).toBe(status);
      expect(await systemComments(ticketId)).toHaveLength(0);
    }
    n += 1;
    const [empty] = await testDb.db
      .insert(tickets)
      .values({ projectId, number: 4000 + n, title: "vuota", type: "bug", priority: "medium", source: "manual" })
      .returning({ id: tickets.id });
    expect((await cancel(empty!.id, developer)).json()).toMatchObject({ code: "nothing_to_cancel" });
  });

  it("una correzione ferma: job e correzione si chiudono INSIEME; la PR resta aperta e intatta", async () => {
    const { ticketId, number } = await taskWithJob("pr_opened");
    await testDb.db.insert(ticketRepositories).values({
      ticketId,
      repositoryId,
      branch: `stubwise/ticket-${number}`,
      prUrl: "https://github.com/acme/shop/pull/77",
      prNumber: 77,
      prState: "open",
    });
    const [correction] = await testDb.db
      .insert(prCorrections)
      .values({ ticketId, repositoryId, prNumber: 77, trigger: "stubwise", status: "queued" })
      .returning({ id: prCorrections.id });
    const [job] = await testDb.db
      .insert(aiJobs)
      .values({ ticketId, status: "held", heldReason: "budget", correctionId: correction!.id, createdAt: new Date(Date.now() + 1000) })
      .returning({ id: aiJobs.id });
    const before = await testDb.db.select().from(ticketRepositories).where(eq(ticketRepositories.ticketId, ticketId));
    const res = await cancel(ticketId, developer);
    expect(res.statusCode, res.body).toBe(200);
    expect((await jobStatus(job!.id)).status).toBe("skipped");
    const [c] = await testDb.db.select({ status: prCorrections.status }).from(prCorrections).where(eq(prCorrections.id, correction!.id));
    expect(c!.status).toBe("done");
    expect(await testDb.db.select().from(ticketRepositories).where(eq(ticketRepositories.ticketId, ticketId))).toEqual(before);
    expect((await systemComments(ticketId))[0]!.body).toMatch(/PR/);
  });
});

/**
 * Una richiesta di annullamento vale per QUEL tentativo (review dell'area 3,
 * punto 1): ogni transizione che fa ripartire il job la azzera. Senza, il job
 * riciclato da `startRun` (o ripreso da un'approvazione, da una risposta)
 * sarebbe annullato al claim dal worker (`checkCancelNow`), per sempre.
 */
describe("dopo un annullamento il lavoro riparte", () => {
  const flag = async (jobId: string) =>
    (
      await testDb.db
        .select({ status: aiJobs.status, at: aiJobs.cancelRequestedAt, by: aiJobs.cancelRequestedByUserId })
        .from(aiJobs)
        .where(eq(aiJobs.id, jobId))
    )[0]!;
  const post = (url: string, who: U, payload?: object) =>
    app.inject({ method: "POST", url, headers: { cookie: who.headers.cookie }, ...(payload ? { payload } : {}) });

  it("annulla → rilancia → il run parte: il job riciclato è in coda SENZA la richiesta di prima", async () => {
    for (const status of ["queued", "fixing"] as const) {
      const { ticketId, jobId } = await taskWithJob(status);
      expect([200, 202]).toContain((await cancel(ticketId, developer)).statusCode);
      // Il worker chiude il job in esecuzione (qui a mano); quello parcheggiato l'ha chiuso il server.
      await testDb.db.update(aiJobs).set({ status: "skipped", finishedAt: new Date() }).where(eq(aiJobs.id, jobId));
      expect((await flag(jobId)).at).not.toBeNull();
      const res = await post(`/api/tickets/${ticketId}/run-ai`, developer);
      expect(res.statusCode, `${status}: ${res.body}`).toBe(202);
      expect(await flag(jobId)).toEqual({ status: expect.stringMatching(/^(queued|awaiting_plan_approval)$/), at: null, by: null });
    }
  });

  it("annullamento chiesto mentre lavorava, poi parcheggiato sul piano → approva il piano → parte senza la richiesta", async () => {
    const { ticketId, jobId } = await taskWithJob("fixing", { planText: "## Piano", requestedByUserId: developer.id });
    expect((await cancel(ticketId, developer)).statusCode).toBe(202);
    // Il job si è parcheggiato prima dell'abort (la corsa del punto 2).
    await testDb.db.update(aiJobs).set({ status: "awaiting_plan_approval" }).where(eq(aiJobs.id, jobId));
    await testDb.db.update(tickets).set({ implementationPlan: "## Piano" }).where(eq(tickets.id, ticketId));
    const res = await post(`/api/tickets/${ticketId}/approve-plan`, lead);
    expect(res.statusCode, res.body).toBe(202);
    expect(await flag(jobId)).toEqual({ status: "queued", at: null, by: null });
  });

  it("annullamento chiesto mentre lavorava, poi parcheggiato su una domanda → rispondi → riparte senza la richiesta", async () => {
    const { ticketId, jobId } = await taskWithJob("fixing", { requestedByUserId: developer.id });
    expect((await cancel(ticketId, developer)).statusCode).toBe(202);
    await testDb.db.update(aiJobs).set({ status: "awaiting_input" }).where(eq(aiJobs.id, jobId));
    const [q] = await testDb.db
      .insert(agentQuestions)
      .values({ jobId, ticketId, round: 1, question: "Quale?", options: [{ label: "A" }, { label: "B" }] })
      .returning({ id: agentQuestions.id });
    const res = await post(`/api/tickets/${ticketId}/questions/answer`, developer, { questionId: q!.id, optionIndex: 0 });
    expect(res.statusCode, res.body).toBe(200);
    expect(await flag(jobId)).toEqual({ status: "queued", at: null, by: null });
  });
});
