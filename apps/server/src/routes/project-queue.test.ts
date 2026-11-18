import { randomUUID } from "node:crypto";
import { automationRuns, automations, changeLog, projectMembers, projects, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";

/** Area 9, F4, Task 5: la pausa e la ripresa della coda di un progetto (solo la coda di Stubwise). */
let t: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;
let seq = 1;

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 3).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const post = (projectId: string, action: "pause" | "resume", cookie = adminCookie) =>
  app.inject({ method: "POST", url: `/api/projects/${projectId}/queue/${action}`, headers: { cookie } });
const projectOf = async (id: string) => (await db.select().from(projects).where(eq(projects.id, id)))[0]!;
async function member(projectId: string, preset: string) {
  const [u] = await db.insert(users).values({ email: `q-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, preset));
  await db.insert(projectMembers).values({ projectId, userId: u!.id, roleId: r!.id });
  return fullSessionCookie(app, u!.id);
}
async function waitingRun(projectId: string, reason: "queue_paused" | "monthly_budget") {
  const n = seq++;
  const [a] = await db.insert(automations).values({ code: `Q${n}-A${n}`, seq: 1000 + n, name: `Auto ${n}`, projectId, ownerId: adminId, status: "active", activeSince: new Date() }).returning();
  const dueAt = new Date(Date.now() + 15 * 60_000);
  const [run] = await db
    .insert(automationRuns)
    .values({ automationId: a!.id, n: 1, version: 1, title: "Run", origin: "manual", event: {}, projectIds: [projectId], status: "running", cursor: { path: [0], aiWaiting: { reason } }, dueAt })
    .returning();
  return run!;
}

describe("la coda di un progetto", () => {
  it("pausa: chi la mette e da quando, la voce; di nuovo → 409 already_paused", async () => {
    const { projectId } = await seedRepository(db);
    expect((await post(projectId, "pause")).statusCode).toBe(204);
    const p = await projectOf(projectId);
    expect(p.queuePausedAt).not.toBeNull();
    expect(p.queuePausedByUserId).toBe(adminId);
    const [entry] = await db.select().from(changeLog).where(and(eq(changeLog.type, "queue.paused"), eq(changeLog.projectId, projectId)));
    expect(entry!.data).toMatchObject({ object: { type: "project", id: projectId, label: p.code } });
    const again = await post(projectId, "pause");
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "already_paused" });
  });

  it("ripresa: azzera la pausa, la voce paused:<ISO> → running; sveglia SUBITO le automazioni ferme per la pausa, non quelle per il budget; non in pausa → 409", async () => {
    const { projectId } = await seedRepository(db);
    const paused = await waitingRun(projectId, "queue_paused");
    const budget = await waitingRun(projectId, "monthly_budget");
    await post(projectId, "pause");
    const pausedAt = (await projectOf(projectId)).queuePausedAt!;
    expect((await post(projectId, "resume")).statusCode).toBe(204);
    expect(await projectOf(projectId)).toMatchObject({ queuePausedAt: null, queuePausedByUserId: null });
    const [entry] = await db.select().from(changeLog).where(and(eq(changeLog.type, "queue.resumed"), eq(changeLog.projectId, projectId)));
    expect(entry!.data).toMatchObject({ before: `paused:${pausedAt.toISOString()}`, after: "running" });
    const dueOf = async (id: string) => (await db.select().from(automationRuns).where(eq(automationRuns.id, id)))[0]!.dueAt!.getTime();
    expect(await dueOf(paused.id)).toBeLessThanOrEqual(Date.now());
    expect(await dueOf(budget.id)).toBeGreaterThan(Date.now() + 60_000);
    const again = await post(projectId, "resume");
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "not_paused" });
  });

  it("NEGATIVI: un Developer (senza gestione) 403 e niente cambia; chi non vede il progetto 404", async () => {
    const { projectId } = await seedRepository(db);
    const dev = await member(projectId, "developer");
    expect((await post(projectId, "pause", dev)).statusCode).toBe(403);
    expect((await projectOf(projectId)).queuePausedAt).toBeNull();
    const other = await seedRepository(db);
    const outsider = await member(other.projectId, "project_lead");
    expect((await post(projectId, "pause", outsider)).statusCode).toBe(404);
    const lead = await member(projectId, "project_lead");
    expect((await post(projectId, "pause", lead)).statusCode).toBe(204);
  });
});
