import { randomUUID } from "node:crypto";
import { aiJobs, changeLog, instanceSettings, productDocJobs, projectMembers, projects, roles, tickets, users, workerHeartbeats, type Db, agentRuns } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { InstanceStatus } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";
import { nightlyRows, retryCheck } from "../services/instance-status.js";
import { recordChange } from "../services/change-log.js";
import { startRun } from "../services/jobs.js";

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

  it("area 11, F6, Task 4: i lavori della doc in coda, in corso e fermi (budget, pausa) hanno la loro riga, senza titolo; i finiti no; R-G5", async () => {
    const s = await seedTicket(db);
    const other = await seedTicket(db);
    const src = () => randomUUID();
    const [running] = await db.insert(productDocJobs).values({ projectId: s.projectId, sourceKind: "email", sourceId: src(), status: "running", startedAt: minutesAgo(1) }).returning();
    const [budget] = await db.insert(productDocJobs).values({ projectId: s.projectId, sourceKind: "meeting", sourceId: src(), status: "held", heldReason: "budget", lastHeldReason: "budget" }).returning();
    const [paused] = await db.insert(productDocJobs).values({ projectId: s.projectId, sourceKind: "task", sourceId: src(), status: "held", heldReason: "paused", lastHeldReason: "paused" }).returning();
    const [done] = await db.insert(productDocJobs).values({ projectId: s.projectId, sourceKind: "decision", sourceId: src(), status: "done" }).returning();
    const [hidden] = await db.insert(productDocJobs).values({ projectId: other.projectId, sourceKind: "email", sourceId: src(), status: "queued" }).returning();
    await db.update(projects).set({ queuePausedAt: new Date(), queuePausedByUserId: adminId }).where(eq(projects.id, s.projectId));
    try {
      const dev = await person([{ projectId: s.projectId, preset: "developer" }]);
      const { body } = await status(dev.cookie);
      const rows = body.jobs.filter((j) => j.kind === "product_doc_update");
      expect(rows.find((j) => j.id === running!.id)).toMatchObject({ state: "running", waiting: null, title: "", code: null, projectCode: expect.any(String) });
      expect(rows.find((j) => j.id === budget!.id)).toMatchObject({ state: "waiting", waiting: { reason: "monthly_budget" } });
      expect(rows.find((j) => j.id === paused!.id)).toMatchObject({ state: "waiting", waiting: { reason: "queue_paused", byId: adminId } });
      expect(rows.map((j) => j.id)).not.toContain(done!.id);
      expect(JSON.stringify(body)).not.toContain(hidden!.id);
    } finally {
      await db.update(projects).set({ queuePausedAt: null, queuePausedByUserId: null }).where(eq(projects.id, s.projectId));
      await db.delete(productDocJobs);
    }
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

describe("il rilancio (Task 6)", () => {
  const retry = (id: string, cookie = adminCookie) => app.inject({ method: "POST", url: `/api/instance/jobs/${id}/retry`, headers: { cookie } });
  const jobsOf = (ticketId: string) => db.select().from(aiJobs).where(eq(aiJobs.ticketId, ticketId));

  it("un fallito si rimette in coda a nome di chi preme, con startRun; la voce job.retried; di nuovo → 409 (superato e vivo)", async () => {
    const s = await seedTicket(db);
    const f = await job(s.ticketId, { status: "failed", finishedAt: minutesAgo(1), createdAt: minutesAgo(5) });
    const res = await retry(f.id);
    expect(res.statusCode).toBe(202);
    const body = res.json() as { jobId: string; status: string; stopsAtPlan: boolean };
    expect(body).toMatchObject({ status: "queued", stopsAtPlan: false });
    // `startRun` ricicla l'ultimo job concluso del ticket: la stessa riga, rimessa in coda.
    const rows = await jobsOf(s.ticketId);
    expect(rows.find((r) => r.id === body.jobId)).toMatchObject({ status: "queued", requestedByUserId: adminId });
    const entries = await db.select().from(changeLog).where(eq(changeLog.type, "job.retried"));
    expect(entries.at(-1)!.data).toMatchObject({ object: { type: "task", id: s.ticketId } });
    expect((await retry(f.id)).statusCode).toBe(409);
  });

  it("NEGATIVI (la correzione: il test puro di retryCheck): un ticket chiuso 422; più vecchio di 7 giorni 422; un Developer 403 e nessun job nuovo; il budget raggiunto 422", async () => {
    const s = await seedTicket(db);
    const c2 = await seedTicket(db, { projectId: s.projectId, repositoryId: s.repositoryId, number: 21 });
    const old = await job(c2.ticketId, { status: "failed", finishedAt: new Date(Date.now() - 8 * 86_400_000) });
    expect((await retry(old.id)).statusCode).toBe(422);
    const c3 = await seedTicket(db, { projectId: s.projectId, repositoryId: s.repositoryId, number: 22 });
    const closedJob = await job(c3.ticketId, { status: "failed", finishedAt: minutesAgo(1) });
    await db.update(tickets).set({ status: "done" }).where(eq(tickets.id, c3.ticketId));
    expect((await retry(closedJob.id)).statusCode).toBe(422);
    const c4 = await seedTicket(db, { projectId: s.projectId, repositoryId: s.repositoryId, number: 23 });
    const f = await job(c4.ticketId, { status: "failed", finishedAt: minutesAgo(1) });
    const dev = await person([{ projectId: s.projectId, preset: "developer" }], []);
    expect((await retry(f.id, dev.cookie)).statusCode).toBe(403);
    expect(await jobsOf(c4.ticketId)).toHaveLength(1);
    await db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" }).onConflictDoUpdate({ target: instanceSettings.id, set: { monthlyBudgetUsd: "1" } });
    const [spent] = await db.insert(agentRuns).values({ phase: "triage", operation: "triage", model: "claude-sonnet-5-5", costUsd: "5" } as typeof agentRuns.$inferInsert).returning({ id: agentRuns.id });
    try {
      const res = await retry(f.id);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: "monthly_budget" });
    } finally {
      await db.delete(agentRuns).where(eq(agentRuns.id, spent!.id));
      await db.update(instanceSettings).set({ monthlyBudgetUsd: null });
    }
  });

  it("chi gestisce e avvia ma non approva i piani: il rilancio si ferma al piano (il gate di startRun)", async () => {
    const s = await seedTicket(db);
    const f = await job(s.ticketId, { status: "failed", finishedAt: minutesAgo(1) });
    const [role] = await db.insert(roles).values({ name: `Gestore ${randomUUID().slice(0, 4)}`, scope: "project", permissions: ["project.settings.manage", "runs.start", "tickets.view_all"] }).returning({ id: roles.id });
    const [u] = await db.insert(users).values({ email: `g-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    await db.insert(projectMembers).values({ projectId: s.projectId, userId: u!.id, roleId: role!.id });
    const res = await retry(f.id, await fullSessionCookie(app, u!.id));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ stopsAtPlan: true });
    const fresh = (await jobsOf(s.ticketId)).find((r) => r.id === (res.json() as { jobId: string }).jobId)!;
    expect(fresh.planApprovalRequired).toBe(true);
  });

  it("chi gestisce il progetto ma non ha runs.start: 403 e nessun job ripartito", async () => {
    const s = await seedTicket(db);
    const f = await job(s.ticketId, { status: "failed", finishedAt: minutesAgo(1) });
    const [role] = await db.insert(roles).values({ name: `Solo gestione ${randomUUID().slice(0, 4)}`, scope: "project", permissions: ["project.settings.manage", "tickets.view_all"] }).returning({ id: roles.id });
    const [u] = await db.insert(users).values({ email: `m-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    await db.insert(projectMembers).values({ projectId: s.projectId, userId: u!.id, roleId: role!.id });
    expect((await retry(f.id, await fullSessionCookie(app, u!.id))).statusCode).toBe(403);
    expect((await jobsOf(s.ticketId))[0]!.status).toBe("failed");
  });

  it("change-log.md: la voce si scrive nella transazione di startRun (afterInTx) — c'è esattamente quando il job riparte", async () => {
    const actor = { id: adminId, permissions: new Set(["runs.start", "plans.approve"]) as never };
    const entriesFor = async (ticketId: string) => (await db.select().from(changeLog).where(eq(changeLog.type, "job.retried"))).filter((e) => (e.data as { object: { id: string } }).object.id === ticketId);
    const entry = async (tx: Parameters<NonNullable<Parameters<typeof startRun>[1]["afterInTx"]>>[0], ticketId: string, projectId: string): Promise<void> => {
      await recordChange(tx, { type: "job.retried", actor: { id: adminId, email: "admin@example.com" }, projectId, data: { object: { type: "task", id: ticketId, label: "X-1" } } });
    };

    // Non riparte (un job in volo): la callback non gira, nessuna voce.
    const busy = await seedTicket(db);
    await job(busy.ticketId, { status: "fixing" });
    let called = 0;
    const r1 = await startRun(db, { ticketId: busy.ticketId, actor, afterInTx: async (tx) => { called++; await entry(tx, busy.ticketId, busy.projectId); } });
    expect(r1.ok).toBe(false);
    expect(called).toBe(0);
    expect(await entriesFor(busy.ticketId)).toHaveLength(0);

    // Un errore DOPO la voce, dentro la transazione: né voce né ripartenza.
    const boom = await seedTicket(db);
    const failedJob = await job(boom.ticketId, { status: "failed", finishedAt: minutesAgo(1) });
    await expect(startRun(db, { ticketId: boom.ticketId, actor, afterInTx: async (tx) => { await entry(tx, boom.ticketId, boom.projectId); throw new Error("dopo la voce"); } })).rejects.toThrow("dopo la voce");
    expect((await jobsOf(boom.ticketId)).find((j) => j.id === failedJob.id)!.status).toBe("failed");
    expect(await entriesFor(boom.ticketId)).toHaveLength(0);

    // Riparte: la voce c'è, una.
    const r3 = await startRun(db, { ticketId: boom.ticketId, actor, afterInTx: (tx) => entry(tx, boom.ticketId, boom.projectId) });
    expect(r3.ok).toBe(true);
    expect(await entriesFor(boom.ticketId)).toHaveLength(1);
  });

  it("review M1: sotto il lock l'ultimo job del ticket dev'essere QUELLO chiesto — se nel frattempo ne è nato un altro, latest_changed e niente cambia", async () => {
    const s = await seedTicket(db);
    const old = await job(s.ticketId, { status: "failed", finishedAt: minutesAgo(10), createdAt: minutesAgo(20) });
    const newer = await job(s.ticketId, { status: "failed", finishedAt: minutesAgo(1), createdAt: minutesAgo(5) });
    const actor = { id: adminId, permissions: new Set(["runs.start", "plans.approve"]) as never };
    const r = await startRun(db, { ticketId: s.ticketId, actor, expectLatestJobId: old.id });
    expect(r).toMatchObject({ ok: false, error: "latest_changed" });
    expect((await jobsOf(s.ticketId)).map((j) => [j.id, j.status]).sort()).toEqual([[old.id, "failed"], [newer.id, "failed"]].sort());
    // Con l'id giusto riparte.
    expect((await startRun(db, { ticketId: s.ticketId, actor, expectLatestJobId: newer.id })).ok).toBe(true);
  });

  it("il rilancio passa da startRun: la rotta non scrive ai_jobs da sé (test di sorgente)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./instance-status.ts", import.meta.url), "utf8");
    expect(source).toContain("startRun(");
    expect(source).not.toMatch(/insert\(aiJobs\)|update\(aiJobs\)/);
    // La voce nella transazione di startRun, con la SUA tx (change-log.md).
    expect(source).toMatch(/afterInTx: async \(tx\) => \{\s*await recordChange\(tx,/);
    expect(source).not.toMatch(/recordChange\(app\.db/);
  });
});
