import { randomBytes } from "node:crypto";
import { aiJobs, comments, prCorrections, ticketRepositories, tickets } from "@stubwise/db";
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

  it("chi non ha runs.start → 403 e niente cambia", async () => {
    const { ticketId, jobId } = await taskWithJob("held");
    expect((await cancel(ticketId, viewer)).statusCode).toBe(403);
    expect((await jobStatus(jobId)).status).toBe("held");
    expect(await systemComments(ticketId)).toHaveLength(0);
  });

  it("un job in esecuzione → 409 run_in_progress; uno concluso o nessun job → 409 nothing_to_cancel; niente cambia", async () => {
    for (const [status, code] of [
      ["triaging", "run_in_progress"],
      ["fixing", "run_in_progress"],
      ["pr_opened", "nothing_to_cancel"],
      ["failed", "nothing_to_cancel"],
      ["skipped", "nothing_to_cancel"],
    ] as const) {
      const { ticketId, jobId } = await taskWithJob(status);
      const res = await cancel(ticketId, developer);
      expect(res.statusCode, status).toBe(409);
      expect(res.json()).toMatchObject({ code });
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
