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

describe("le letture di un archiviato (Task 4)", () => {
  async function archivedProject(opts: { name?: string } = {}) {
    const { projectId, repositoryId } = await seedRepository(db);
    if (opts.name) await db.update(projects).set({ name: opts.name }).where(eq(projects.id, projectId));
    const lead = await member(projectId, "project_lead");
    const dev = await member(projectId, "developer");
    return { projectId, repositoryId, lead, dev };
  }

  it("GET /api/projects/archived: i membri di allora e i full admin, dal più recente, coi permessi calcolati dal server; un estraneo la lista vuota", async () => {
    const first = await archivedProject();
    const second = await archivedProject();
    expect((await call("POST", first.projectId, "archive")).statusCode).toBe(204);
    expect((await call("POST", second.projectId, "archive")).statusCode).toBe(204);
    await member(second.projectId, "developer");
    const list = async (cookie: string) => (await app.inject({ method: "GET", url: "/api/projects/archived", headers: { cookie } })).json() as Record<string, unknown>[];
    const admin = (await list(adminCookie)).filter((r) => r.projectId === first.projectId || r.projectId === second.projectId);
    expect(admin.map((r) => r.projectId)).toEqual([second.projectId, first.projectId]);
    expect(admin[0]).toMatchObject({ canReopen: true, canDelete: true, archivedBy: expect.any(String), clientName: null });
    expect((await list(first.lead.cookie)).map((r) => r.projectId)).toEqual([first.projectId]);
    expect((await list(first.lead.cookie))[0]).toMatchObject({ canReopen: true, canDelete: false });
    expect((await list(first.dev.cookie))[0]).toMatchObject({ canReopen: false, canDelete: false });
    const { cookie: stranger } = await member((await seedRepository(db)).projectId, "project_lead");
    expect(await list(stranger)).toEqual([]);
  });

  it("archivedBy è null quando chi ha archiviato non c'è più", async () => {
    const p = await archivedProject();
    expect((await call("POST", p.projectId, "archive", p.lead.cookie)).statusCode).toBe(204);
    await db.delete(users).where(eq(users.id, p.lead.id));
    const rows = (await app.inject({ method: "GET", url: "/api/projects/archived", headers: { cookie: adminCookie } })).json() as { projectId: string; archivedBy: string | null }[];
    expect(rows.find((r) => r.projectId === p.projectId)!.archivedBy).toBeNull();
  });

  it("archived-view: descrizione, membri umani col ruolo, i dieci conteggi, i repository, gli interruttori com'erano, la cadenza del pulse", async () => {
    const p = await archivedProject();
    await db.update(projects).set({ description: "Il sito", weeklyBriefEnabled: true, pulseEveryDays: 5 }).where(eq(projects.id, p.projectId));
    await ticket(p.projectId, "Una task");
    await ticket(p.projectId, "Un'altra");
    await run(p.projectId, "done");
    const [agent] = await db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
    await db.insert(projectMembers).values({ projectId: p.projectId, userId: agent!.id, roleId: r!.id });
    expect((await call("POST", p.projectId, "archive")).statusCode).toBe(204);
    const res = await call("GET", p.projectId, "archived-view", p.dev.cookie);
    expect(res.statusCode).toBe(200);
    const view = res.json() as Record<string, unknown> & { members: { personId: string; role: string }[] };
    expect(view).toMatchObject({
      projectId: p.projectId,
      description: "Il sito",
      // Il canale del progetto nasce col progetto.
      counts: { tasks: 2, requests: 0, docPages: 0, conversations: 0, channels: 1, driveFiles: 0, automations: 1, environments: 0, envFiles: 0, releases: 0 },
      repositories: ["Repository di test"],
      switchesOnReopen: { docsNightly: false, dailyReport: false, backlogDiscovery: false, pulse: false, weeklyBrief: true },
      pulseEveryDays: 5,
      canReopen: false,
      canDelete: false,
    });
    expect(view.members.map((m) => m.personId).sort()).toEqual([p.lead.id, p.dev.id].sort());
    expect(view.members.find((m) => m.personId === p.lead.id)!.role).toBe("Project Lead");
  });

  it("NEGATIVI: archived-view di un aperto è 404, di un estraneo 404; il membro di allora legge ma non scrive (409)", async () => {
    const p = await archivedProject();
    expect((await call("GET", p.projectId, "archived-view")).statusCode).toBe(404);
    expect((await call("POST", p.projectId, "archive")).statusCode).toBe(204);
    const { cookie: stranger } = await member((await seedRepository(db)).projectId, "project_lead");
    expect((await call("GET", p.projectId, "archived-view", stranger)).statusCode).toBe(404);
    expect((await call("GET", p.projectId, "archived-view", p.lead.cookie)).statusCode).toBe(200);
    const patch = await app.inject({ method: "PATCH", url: `/api/projects/${p.projectId}`, headers: { cookie: p.lead.cookie }, payload: { name: "Nuovo" } });
    expect(patch.statusCode).toBe(409);
  });

  it("il registro: le voci dell'archiviato si leggono filtrando il progetto, da chi lo vede da archiviato; non da un estraneo", async () => {
    const p = await archivedProject();
    expect((await call("POST", p.projectId, "archive", p.lead.cookie)).statusCode).toBe(204);
    const log = async (cookie: string) => app.inject({ method: "GET", url: `/api/change-log?project=${p.projectId}`, headers: { cookie } });
    const mine = await log(p.lead.cookie);
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as { entries: { type: string }[] }).entries.map((e) => e.type)).toContain("project.archived");
    const { cookie: stranger } = await member((await seedRepository(db)).projectId, "project_lead");
    expect((((await log(stranger)).json() as { entries: unknown[] }).entries)).toEqual([]);
  });
});
