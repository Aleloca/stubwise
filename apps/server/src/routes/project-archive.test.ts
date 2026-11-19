import { randomUUID } from "node:crypto";
import {
  agentSessions,
  aiJobs,
  automationRunInputs,
  automationRuns,
  automations,
  changeLog,
  docGenerations,
  prReviews,
  projectMembers,
  projects,
  releases,
  roles,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F6, Task 3 (D-8): archivia e riapri. Lo impedisce solo il lavoro
 * in esecuzione (L-5 = a); le esecuzioni aperte delle automazioni si
 * annullano con la loro ragione; riaprire riporta tutto com'era.
 */
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
  ({ adminCookie, adminId } = await seedUsers(app));
}, 120_000);
afterAll(async () => {
  await app.close();
  await t.stop();
});

const call = (method: "GET" | "POST", projectId: string, action: string, cookie = adminCookie) =>
  app.inject({ method, url: `/api/projects/${projectId}/${action}`, headers: { cookie } });
const projectOf = async (id: string) => (await db.select().from(projects).where(eq(projects.id, id)))[0]!;
const entries = async (projectId: string, type: string) => db.select().from(changeLog).where(and(eq(changeLog.projectId, projectId), eq(changeLog.type, type)));
async function member(projectId: string, preset: string) {
  const [u] = await db.insert(users).values({ email: `a-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, preset));
  await db.insert(projectMembers).values({ projectId, userId: u!.id, roleId: r!.id });
  return { id: u!.id, cookie: await fullSessionCookie(app, u!.id) };
}
async function run(projectId: string, status: (typeof automationRuns.$inferInsert)["status"]) {
  const n = seq++;
  const [a] = await db.insert(automations).values({ code: `AR${n}-A${n}`, seq: 5000 + n, name: `Auto ${n}`, projectId, ownerId: adminId, status: "active", activeSince: new Date() }).returning();
  const [r] = await db.insert(automationRuns).values({ automationId: a!.id, n: 1, version: 1, title: "Run", origin: "manual", event: {}, projectIds: [projectId], status }).returning();
  return r!;
}
async function ticket(projectId: string, title: string) {
  const n = seq++;
  const [tk] = await db.insert(tickets).values({ projectId, number: n, title, type: "bug", priority: "medium", status: "in_progress", source: "manual" }).returning();
  return tk!;
}
async function liveSession(projectId: string, kind: "free" | "project_brief", title: string) {
  await db.insert(agentSessions).values({ ownerKey: `test:${randomUUID()}`, kind, title, projectId, liveSegmentIds: ["s1"], heartbeatAt: new Date() });
}

describe("archive-preview e busy (L-5 = a)", () => {
  it("un progetto quieto: niente busy, le esecuzioni aperte contate (non le chiuse)", async () => {
    const { projectId } = await seedRepository(db);
    await run(projectId, "running");
    await run(projectId, "waiting_approval");
    await run(projectId, "done");
    const res = await call("GET", projectId, "archive-preview");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ openAutomationRuns: 2, busy: [] });
  });

  it("ogni ragione: un job al lavoro, una review in corso, una sessione dal vivo (cieca se non la vedi), una generazione in pausa, un rilascio con le run aperte", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const [p] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
    const tk = await ticket(projectId, "Sistema il login");
    await db.insert(aiJobs).values({ ticketId: tk.id, status: "fixing" });
    // In attesa di una persona: NON blocca (L-5 = a).
    const waiting = await ticket(projectId, "Aspetta una risposta");
    await db.insert(aiJobs).values({ ticketId: waiting.id, status: "awaiting_input" });
    await db.insert(prReviews).values({ repositoryId, prNumber: 7, prUrl: "https://x/pr/7", prTitle: "Nuovo menu", headSha: "a".repeat(40), status: "running" });
    await liveSession(projectId, "project_brief", "Il brief della settimana");
    await liveSession(projectId, "free", "Una chat privata");
    await db.insert(docGenerations).values({ repositoryId, status: "paused" });
    await db.insert(releases).values({ projectId, repositoryId, code: `${p!.code}-V9`, seq: 9, prNumber: 3, prUrl: "https://x/pr/3", title: "R", mergeSha: "b".repeat(40), mergedAt: new Date(), viaStubwise: false });
    const res = await call("GET", projectId, "archive-preview");
    const busy = (res.json() as { busy: Record<string, unknown>[] }).busy;
    expect(busy).toEqual([
      { kind: "claude_session", code: `${p!.code}-${tk.number}`, title: "Sistema il login", waiting: false, repository: null, paused: false },
      { kind: "claude_session", code: null, title: "#7 Nuovo menu", waiting: false, repository: null, paused: false },
      { kind: "claude_session", code: null, title: "Il brief della settimana", waiting: false, repository: null, paused: false },
      // Una conversazione privata: nemmeno il full admin ne legge il titolo.
      { kind: "claude_session", code: null, title: null, waiting: false, repository: null, paused: false },
      { kind: "doc_generation", code: null, title: null, waiting: false, repository: "Repository di test", paused: true },
      { kind: "release", code: `${p!.code}-V9`, title: null, waiting: false, repository: null, paused: false },
    ]);
    // Archiviare: 409 busy con le stesse ragioni, e niente cambia.
    const archive = await call("POST", projectId, "archive");
    expect(archive.statusCode).toBe(409);
    expect(archive.json()).toMatchObject({ code: "busy", reasons: busy });
    expect((await projectOf(projectId)).archivedAt).toBeNull();
    expect(await entries(projectId, "project.archived")).toEqual([]);
  });
});

describe("archivia e riapri", () => {
  it("archivia: le colonne, la voce, le esecuzioni aperte annullate con la ragione; riapri: tutto com'era", async () => {
    const { projectId } = await seedRepository(db);
    const open = await run(projectId, "suspended");
    const closed = await run(projectId, "done");
    await db.update(projects).set({ weeklyBriefEnabled: true }).where(eq(projects.id, projectId));
    const res = await call("POST", projectId, "archive");
    expect(res.statusCode).toBe(204);
    const archived = await projectOf(projectId);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.archivedByUserId).toBe(adminId);
    expect(archived.weeklyBriefEnabled).toBe(true);
    expect(await entries(projectId, "project.archived")).toHaveLength(1);
    const inputs = await db.select().from(automationRunInputs);
    expect(inputs.filter((i) => i.runId === open.id).map((i) => i.input)).toEqual([{ control: "cancel", byId: adminId, reason: "project_archived" }]);
    expect(inputs.filter((i) => i.runId === closed.id)).toEqual([]);
    // Già archiviato.
    const again = await call("POST", projectId, "archive");
    expect(again.statusCode).toBe(409);
    expect((again.json() as { code: string }).code).toBe("already_archived");
    // Riapri.
    const reopen = await call("POST", projectId, "reopen");
    expect(reopen.statusCode).toBe(204);
    const back = await projectOf(projectId);
    expect(back).toMatchObject({ archivedAt: null, archivedByUserId: null, weeklyBriefEnabled: true });
    expect(await entries(projectId, "project.reopened")).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: { cookie: adminCookie } })).statusCode).toBe(200);
    // Già aperto.
    const notArchived = await call("POST", projectId, "reopen");
    expect(notArchived.statusCode).toBe(409);
    expect((notArchived.json() as { code: string }).code).toBe("not_archived");
  });

  it("due archiviazioni insieme: una sola passa, una sola voce", async () => {
    const { projectId } = await seedRepository(db);
    const [a, b] = await Promise.all([call("POST", projectId, "archive"), call("POST", projectId, "archive")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([204, 409]);
    expect(await entries(projectId, "project.archived")).toHaveLength(1);
  });

  it("la voce nella transazione: se non si scrive, il progetto non è archiviato", async () => {
    const { projectId } = await seedRepository(db);
    await db.execute(sql`CREATE OR REPLACE FUNCTION f6_fail_entry() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'voce fallita (test)'; END $$ LANGUAGE plpgsql`);
    await db.execute(sql.raw(`CREATE TRIGGER f6_fail_entry BEFORE INSERT ON change_log FOR EACH ROW WHEN (NEW.type = 'project.archived') EXECUTE FUNCTION f6_fail_entry()`));
    try {
      expect((await call("POST", projectId, "archive")).statusCode).toBe(500);
    } finally {
      await db.execute(sql`DROP TRIGGER f6_fail_entry ON change_log`);
      await db.execute(sql`DROP FUNCTION f6_fail_entry()`);
    }
    expect((await projectOf(projectId)).archivedAt).toBeNull();
  });

  it("NEGATIVI: un Developer 403 (preview, archivia, riapri), un estraneo 404; niente cambia", async () => {
    const { projectId } = await seedRepository(db);
    const dev = await member(projectId, "developer");
    const { cookie: stranger } = await member((await seedRepository(db)).projectId, "project_lead");
    for (const action of ["archive-preview", "archive"]) {
      expect((await call(action === "archive" ? "POST" : "GET", projectId, action, dev.cookie)).statusCode).toBe(403);
      expect((await call(action === "archive" ? "POST" : "GET", projectId, action, stranger)).statusCode).toBe(404);
    }
    expect((await projectOf(projectId)).archivedAt).toBeNull();
    expect((await call("POST", projectId, "archive")).statusCode).toBe(204);
    expect((await call("POST", projectId, "reopen", dev.cookie)).statusCode).toBe(403);
    expect((await call("POST", projectId, "reopen", stranger)).statusCode).toBe(404);
    expect((await projectOf(projectId)).archivedAt).not.toBeNull();
  });
});
