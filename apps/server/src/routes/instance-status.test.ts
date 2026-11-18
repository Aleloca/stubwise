import { randomUUID } from "node:crypto";
import { aiJobs, instanceSettings, projectMembers, projects, roles, tickets, users, workerHeartbeats, type Db, agentRuns } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { InstanceStatus } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";
import { nightlyRows, retryCheck } from "../services/instance-status.js";

/**
 * Area 9, F4, Task 4: lo Stato dell'istanza. La forma del prototipo,
 * calcolata dal server: i lavori dei progetti visibili, gli altri solo
 * contati (R-G5), il Retry con i suoi permessi e blocchi, i 7 giorni, i
 * worker dall'heartbeat, la pausa di ogni coda.
 */
let t: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const status = async (cookie = adminCookie) => {
  const res = await app.inject({ method: "GET", url: "/api/instance/status", headers: { cookie } });
  return { code: res.statusCode, body: res.json() as InstanceStatus };
};
async function job(ticketId: string, values: Partial<typeof aiJobs.$inferInsert>) {
  const [j] = await db.insert(aiJobs).values({ ticketId, ...values }).returning();
  return j!;
}
async function person(projectRoles: { projectId: string; preset: string }[], instancePerms: string[] = ["instance.status.view"]) {
  const [role] = await db.insert(roles).values({ name: `I ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: instancePerms }).returning({ id: roles.id });
  const [u] = await db.insert(users).values({ email: `s-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member", instanceRoleId: role!.id }).returning({ id: users.id });
  for (const pr of projectRoles) {
    const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, pr.preset));
    await db.insert(projectMembers).values({ projectId: pr.projectId, userId: u!.id, roleId: r!.id });
  }
  return { id: u!.id, cookie: await fullSessionCookie(app, u!.id) };
}

describe("lo Stato dell'istanza", () => {
  it("senza instance.status.view: 403", async () => {
    const p = await person([], []);
    expect((await status(p.cookie)).code).toBe(403);
  });

  it("la forma: in corso, in coda su una coda in pausa (chi e da quando), fallito col Retry, superato, una correzione ferma senza Retry; i 7 giorni", async () => {
    const a = await seedTicket(db);
    const b = await seedTicket(db, { projectId: a.projectId, repositoryId: a.repositoryId, number: 2 });
    const c = await seedTicket(db, { projectId: a.projectId, repositoryId: a.repositoryId, number: 3 });
    const running = await job(a.ticketId, { status: "fixing", startedAt: minutesAgo(3) });
    const failed = await job(b.ticketId, { status: "failed", finishedAt: minutesAgo(10), failureSummary: "Tests didn't pass" });
    const old = await job(b.ticketId, { status: "failed", finishedAt: new Date(Date.now() - 8 * 24 * 3600_000), createdAt: new Date(Date.now() - 8 * 24 * 3600_000) });
    const supersededFailed = await job(c.ticketId, { status: "failed", finishedAt: minutesAgo(30), createdAt: minutesAgo(40) });
    await job(c.ticketId, { status: "queued", createdAt: minutesAgo(5) });
    await db.update(projects).set({ queuePausedAt: minutesAgo(20), queuePausedByUserId: adminId }).where(eq(projects.id, a.projectId));

    const { code, body } = await status();
    expect(code).toBe(200);
    const byId = new Map(body.jobs.map((j) => [j.id, j]));
    expect(byId.get(running.id)).toMatchObject({ kind: "task_run", state: "running", retry: "unavailable" });
    const queued = body.jobs.find((j) => j.state === "waiting" && j.projectId === a.projectId)!;
    expect(queued.waiting).toMatchObject({ reason: "queue_paused", byId: adminId });
    expect(byId.get(failed.id)).toMatchObject({ state: "failed", summary: "Tests didn't pass", retry: "allowed", retryStopsAtPlan: false, superseded: false });
    expect(byId.has(old.id)).toBe(false);
    expect(byId.get(supersededFailed.id)).toMatchObject({ superseded: true, retry: "unavailable" });
    const queue = body.queues.find((q) => q.projectId === a.projectId)!;
    expect(queue).toMatchObject({ pause: "allowed", running: 1, waiting: 1, failed: 2 });
    expect(queue.paused).toMatchObject({ byId: adminId });
    expect(body.errors[0]!.jobId).toBe(failed.id);
    await db.update(projects).set({ queuePausedAt: null, queuePausedByUserId: null }).where(eq(projects.id, a.projectId));
  });

  it("R-G5: i lavori di un progetto che chi guarda non vede sono solo contati; il worker che ci lavora è `hidden`", async () => {
    const mine = await seedTicket(db);
    const other = await seedTicket(db);
    const otherRunning = await job(other.ticketId, { status: "fixing", startedAt: minutesAgo(1) });
    await job(mine.ticketId, { status: "failed", finishedAt: minutesAgo(2) });
    await db.insert(workerHeartbeats).values({ workerId: "w-test", concurrency: 2, running: [{ kind: "ai_job", id: otherRunning.id }] });
    const dev = await person([{ projectId: mine.projectId, preset: "developer" }]);
    const { body } = await status(dev.cookie);
    expect(body.jobs.every((j) => j.projectId === mine.projectId)).toBe(true);
    expect(body.queues.map((q) => q.projectId)).toEqual([mine.projectId]);
    expect(body.otherProjects).not.toBeNull();
    expect(body.otherProjects!.running).toBeGreaterThanOrEqual(1);
    expect(body.workers).toContainEqual({ id: "w-test:1", jobId: null, hidden: true });
    expect(body.workers).toContainEqual({ id: "w-test:2", jobId: null, hidden: false });
    expect(JSON.stringify(body)).not.toContain(otherRunning.id);
    // Un Developer non gestisce il progetto: la pausa è forbidden e il Retry chiede la gestione.
    expect(body.queues[0]!.pause).toBe("forbidden");
    expect(body.jobs.find((j) => j.state === "failed")).toMatchObject({ retry: "forbidden", retryNeeds: "manageSettings" });
    await db.delete(workerHeartbeats);
  });

  it("il budget raggiunto spegne il Retry (retryBlock) e conta in budgetAfterResume", async () => {
    const s = await seedTicket(db);
    const f = await job(s.ticketId, { status: "failed", finishedAt: minutesAgo(1) });
    await job((await seedTicket(db, { projectId: s.projectId, repositoryId: s.repositoryId, number: 9 })).ticketId, { status: "queued" });
    await db.update(projects).set({ queuePausedAt: new Date(), queuePausedByUserId: adminId }).where(eq(projects.id, s.projectId));
    await db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    const [spent] = await db.insert(agentRuns).values({ phase: "triage", operation: "triage", model: "claude-sonnet-5-5", costUsd: "5" } as typeof agentRuns.$inferInsert).returning({ id: agentRuns.id });
    try {
      const { body } = await status();
      expect(body.jobs.find((j) => j.id === f.id)).toMatchObject({ retry: "forbidden", retryNeeds: null, retryBlock: { reason: "monthly_budget" } });
      expect(body.queues.find((q) => q.projectId === s.projectId)!.budgetAfterResume).toBe(1);
    } finally {
      await db.delete(agentRuns).where(eq(agentRuns.id, spent!.id));
      await db.update(instanceSettings).set({ monthlyBudgetUsd: null });
      await db.update(projects).set({ queuePausedAt: null }).where(eq(projects.id, s.projectId));
    }
  });

  it("un job fermo che aspetta una persona (held senza correzione, piano da approvare) non è lavoro della coda", async () => {
    const s = await seedTicket(db);
    const held = await job(s.ticketId, { status: "held" });
    const plan = await job((await seedTicket(db, { projectId: s.projectId, repositoryId: s.repositoryId, number: 5 })).ticketId, { status: "awaiting_plan_approval" });
    const ids = (await status()).body.jobs.map((j) => j.id);
    expect(ids).not.toContain(held.id);
    expect(ids).not.toContain(plan.id);
  });

  it("un ticket chiuso non si rilancia", async () => {
    const s = await seedTicket(db);
    const f = await job(s.ticketId, { status: "failed", finishedAt: minutesAgo(1) });
    await db.update(tickets).set({ status: "done" }).where(eq(tickets.id, s.ticketId));
    expect((await status()).body.jobs.find((j) => j.id === f.id)).toMatchObject({ retry: "unavailable" });
  });
});

describe("le regole pure", () => {
  const now = new Date("2026-11-18T12:00:00.000Z");
  const all = new Set(["project.settings.manage", "runs.start", "plans.approve"]);
  const facts = { status: "failed", isCorrection: false, finishedAt: new Date("2026-11-18T11:00:00.000Z"), ticketClosed: false, newer: null };
  it("retryCheck: correzione, superato vivo (conflict) e finito, permessi, gate del piano", () => {
    expect(retryCheck({ ...facts, isCorrection: true }, all, false, now)).toMatchObject({ retry: "unavailable", reason: "not_retryable" });
    expect(retryCheck({ ...facts, newer: { live: true } }, all, false, now)).toMatchObject({ retry: "unavailable", reason: "conflict" });
    expect(retryCheck({ ...facts, newer: { live: false } }, all, false, now)).toMatchObject({ retry: "unavailable", reason: "not_retryable" });
    expect(retryCheck(facts, new Set(["project.settings.manage"]), false, now)).toMatchObject({ retry: "forbidden", retryNeeds: "startRun" });
    expect(retryCheck(facts, new Set(["project.settings.manage", "runs.start"]), false, now)).toMatchObject({ retry: "allowed", retryStopsAtPlan: true });
    expect(retryCheck({ ...facts, finishedAt: new Date("2026-11-10T11:00:00.000Z") }, all, false, now)).toMatchObject({ retry: "unavailable" });
  });
  it("nightlyRows: una riga per repository e fase; fallita > in corso > in attesa > fatta; il daily report non si mostra", () => {
    const base = { repositoryId: "r", projectId: "p", lastError: null, updatedAt: now };
    const rows = nightlyRows(
      [
        { ...base, phase: "summary", status: "done", claimedAt: null },
        { ...base, phase: "summary", status: "pending", claimedAt: new Date(now.getTime() - 60_000) },
        { ...base, phase: "page_update", status: "failed", claimedAt: null, lastError: "boom" },
        { ...base, phase: "page_create", status: "done", claimedAt: null },
        { ...base, phase: "daily_report", status: "pending", claimedAt: null },
      ],
      now,
      3_600_000,
    );
    expect(rows.map((r) => [r.phase, r.state, r.summary]).sort()).toEqual([
      ["commit_summary", "running", null],
      ["docs", "failed", "boom"],
    ]);
  });
});
