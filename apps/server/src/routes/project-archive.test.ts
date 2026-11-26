import { randomUUID } from "node:crypto";
import {
  agentSessions,
  aiJobs,
  automationRunInputs,
  automationRuns,
  automations,
  changeLog,
  commitSummaries,
  deletedProjectMembers,
  deletedProjects,
  docGenerations,
  driveFiles,
  environmentServers,
  graphJobs,
  prReviews,
  projectMembers,
  projects,
  releases,
  repositories,
  roles,
  servers,
  tickets,
  users,
  widgets,
  type Db,
} from "@stubwise/db";
import { seedEnvironment, seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
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
    expect(res.json()).toEqual({ openAutomationRuns: 2, busy: [], publicSurfaces: { sdk: false, widget: false, inbound: false, gitWebhook: false } });
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

describe("archive-preview: le superfici pubbliche che archiviare spegne", () => {
  it("vere solo quando il progetto le usa davvero: SDK e ingresso recenti, widget acceso, webhook configurato", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const surfaces = async () => ((await call("GET", projectId, "archive-preview")).json() as { publicSurfaces: Record<string, boolean> }).publicSurfaces;
    // Un widget spento e un ticket SDK vecchio non contano.
    await db.insert(widgets).values({ projectId, name: "Spento", key: `k-${randomUUID()}`, enabled: false });
    const old = new Date(Date.now() - 120 * 86_400_000);
    await db.insert(tickets).values({ projectId, number: seq++, title: "vecchio", type: "bug", priority: "medium", status: "triaged", source: "sdk_error", createdAt: old });
    expect(await surfaces()).toEqual({ sdk: false, widget: false, inbound: false, gitWebhook: false });
    await db.insert(tickets).values({ projectId, number: seq++, title: "errore", type: "bug", priority: "medium", status: "triaged", source: "sdk_feedback" });
    expect(await surfaces()).toMatchObject({ sdk: true, widget: false, inbound: false, gitWebhook: false });
    await db.insert(widgets).values({ projectId, name: "Acceso", key: `k-${randomUUID()}`, enabled: true });
    await db.insert(tickets).values({ projectId, number: seq++, title: "dal form", type: "bug", priority: "medium", status: "triaged", source: "webhook" });
    await db.update(repositories).set({ webhookConfiguredAt: new Date() }).where(eq(repositories.id, repositoryId));
    expect(await surfaces()).toEqual({ sdk: true, widget: true, inbound: true, gitWebhook: true });
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
    // Un file del Drive eliminato non conta (quello che il contatore promette).
    for (const [n, deletedAt] of [[1, null], [2, new Date()]] as const) {
      await db.insert(driveFiles).values({ projectId: p.projectId, number: n, name: `doc-${n}.pdf`, mime: "application/pdf", type: "pdf", sizeBytes: 1, storageKey: `drive/${p.projectId}/${randomUUID()}/x.pdf`, addedBy: adminId, contentStatus: "ready", contentOcr: "none", deletedAt });
    }
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
      counts: { tasks: 2, requests: 0, docPages: 0, conversations: 0, channels: 1, driveFiles: 1, automations: 1, environments: 0, envFiles: 0, releases: 0 },
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
    // `projectArchived` si DERIVA: lo porta anche una voce scritta prima dell'archivio (senza il campo nel jsonb).
    const old = (mine.json() as { entries: { type: string; projectArchived: boolean }[] }).entries;
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((e) => e.projectArchived)).toBe(true);
    const [raw] = await db.select({ data: changeLog.data }).from(changeLog).where(and(eq(changeLog.projectId, p.projectId), eq(changeLog.type, "project.archived")));
    expect(raw!.data).not.toHaveProperty("projectArchived");
    // Riaperto, le stesse voci non lo dicono più.
    expect((await call("POST", p.projectId, "reopen", p.lead.cookie)).statusCode).toBe(204);
    const reopened = (await log(p.lead.cookie)).json() as { entries: { projectArchived: boolean }[] };
    expect(reopened.entries.every((e) => !e.projectArchived)).toBe(true);
    const { cookie: stranger } = await member((await seedRepository(db)).projectId, "project_lead");
    expect((((await log(stranger)).json() as { entries: unknown[] }).entries)).toEqual([]);
  });
});

describe("elimina (Task 5): solo un archiviato, solo un full admin", () => {
  const del = (projectId: string, cookie: string, body?: unknown) =>
    app.inject({ method: "DELETE", url: `/api/projects/${projectId}`, headers: { cookie }, ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) });
  async function staleAdmin() {
    const old = await createSession(db, adminId, { stage: "full", secondFactorAt: new Date(Date.now() - 11 * 60_000) });
    return `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(old.id))}`;
  }
  async function archivedWithRepo() {
    const { projectId, repositoryId } = await seedRepository(db);
    const lead = await member(projectId, "project_lead");
    const [p] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
    return { projectId, repositoryId, lead, code: p!.code };
  }

  it("deletion-preview: i conteggi, i server che restano orfani (solo quelli di questo progetto), i repository che restano staccati; solo un full admin, solo un archiviato", async () => {
    const p = await archivedWithRepo();
    const other = await seedRepository(db);
    const mine = await seedEnvironment(db, p.projectId);
    const mine2 = await seedEnvironment(db, p.projectId, { kind: "staging" });
    const theirs = await seedEnvironment(db, other.projectId);
    const [solo] = await db.insert(servers).values({ name: "solo", keyHash: randomUUID() }).returning();
    const [shared] = await db.insert(servers).values({ name: "condiviso", keyHash: randomUUID() }).returning();
    await db.insert(environmentServers).values([
      { environmentId: mine, repositoryId: p.repositoryId, serverId: solo!.id },
      { environmentId: mine2, repositoryId: p.repositoryId, serverId: shared!.id },
      { environmentId: theirs, repositoryId: other.repositoryId, serverId: shared!.id },
    ]);
    expect((await call("GET", p.projectId, "deletion-preview")).statusCode).toBe(409);
    expect((await call("POST", p.projectId, "archive")).statusCode).toBe(204);
    expect((await call("GET", p.projectId, "deletion-preview", p.lead.cookie)).statusCode).toBe(403);
    const res = await call("GET", p.projectId, "deletion-preview");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orphanServers: [`SRV-${solo!.number}`], detachedRepositories: ["Repository di test"], counts: { environments: 2 } });
  });

  it("NEGATIVI: aperto 409, non full admin 403, senza riconferma 403, codice sbagliato (anche in minuscolo) 400, senza corpo 400; niente cambia", async () => {
    const p = await archivedWithRepo();
    expect((await del(p.projectId, adminCookie, { confirmCode: p.code })).json()).toMatchObject({ code: "not_archived" });
    expect((await call("POST", p.projectId, "archive")).statusCode).toBe(204);
    const notAdmin = await del(p.projectId, p.lead.cookie, { confirmCode: p.code });
    expect(notAdmin.statusCode).toBe(403);
    const stale = await del(p.projectId, await staleAdmin(), { confirmCode: p.code });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ code: "reauth_required" });
    const lower = await del(p.projectId, adminCookie, { confirmCode: p.code.toLowerCase() });
    expect(lower.statusCode).toBe(400);
    expect(lower.json()).toMatchObject({ code: "code_mismatch" });
    expect((await del(p.projectId, adminCookie)).statusCode).toBe(400);
    expect(await projectOf(p.projectId)).toBeDefined();
    expect(await db.select().from(deletedProjects).where(eq(deletedProjects.id, p.projectId))).toEqual([]);
  });

  it("elimina: i repository restano staccati (con la storia dei commit, senza Docs né PR), la memoria del progetto, la voce d'istanza; le voci di progetto non le legge più nessuno", async () => {
    const p = await archivedWithRepo();
    await db.insert(commitSummaries).values({ repositoryId: p.repositoryId, sha: "c".repeat(40), authorName: "Bea", authorEmail: "bea@acme.com", subject: "x", summary: "x", committedAt: new Date() });
    await db.insert(docGenerations).values({ repositoryId: p.repositoryId, status: "succeeded" });
    await db.insert(prReviews).values({ repositoryId: p.repositoryId, prNumber: 1, prUrl: "https://x/pr/1", prTitle: "PR", headSha: "a".repeat(40), status: "completed" });
    await db.insert(graphJobs).values({ repositoryId: p.repositoryId, kind: "build" });
    expect((await call("POST", p.projectId, "archive")).statusCode).toBe(204);
    const res = await del(p.projectId, adminCookie, { confirmCode: p.code });
    expect(res.statusCode).toBe(204);
    expect(await db.select().from(projects).where(eq(projects.id, p.projectId))).toEqual([]);
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, p.repositoryId));
    expect(repo).toMatchObject({ projectId: null, detachedFromProjectId: p.projectId, webhookConfiguredAt: null, currentDocGenerationId: null });
    expect(repo!.detachedAt).toBeInstanceOf(Date);
    expect(await db.select().from(commitSummaries).where(eq(commitSummaries.repositoryId, p.repositoryId))).toHaveLength(1);
    expect(await db.select().from(docGenerations).where(eq(docGenerations.repositoryId, p.repositoryId))).toEqual([]);
    expect(await db.select().from(prReviews).where(eq(prReviews.repositoryId, p.repositoryId))).toEqual([]);
    expect(await db.select().from(graphJobs).where(eq(graphJobs.repositoryId, p.repositoryId))).toEqual([]);
    expect(await db.select().from(deletedProjects).where(eq(deletedProjects.id, p.projectId))).toMatchObject([{ code: p.code }]);
    expect((await db.select().from(deletedProjectMembers).where(eq(deletedProjectMembers.projectId, p.projectId))).map((m) => m.userId)).toContain(p.lead.id);
    const [entry] = await db.select().from(changeLog).where(and(eq(changeLog.type, "project.deleted"), eq(changeLog.subjectId, p.projectId)));
    expect(entry).toMatchObject({ projectId: null });
    expect(entry!.data).toMatchObject({ params: { detachedRepositories: "1" } });
    // Le voci di progetto restano col loro project_id, ma nessuno le legge più.
    expect(await entries(p.projectId, "project.archived")).toHaveLength(1);
    const log = (await app.inject({ method: "GET", url: "/api/change-log", headers: { cookie: adminCookie } })).json() as { entries: { type: string; projectId: string | null; hidden: boolean; data: { object: { id: string; label: string } } }[] };
    expect(log.entries.filter((e) => e.projectId === p.projectId)).toEqual([]);
    // `project.deleted` si risolve a lettura: il full admin lo conosceva.
    const mine = log.entries.find((e) => e.type === "project.deleted" && e.data.object.id === p.projectId);
    expect(mine).toMatchObject({ hidden: false, data: { object: { label: `${p.code} · Progetto di test` } } });
    // Chi legge tutto il registro (`changelog.view`) ma non ne era membro: «un progetto che non vedi».
    const [u] = await db.insert(users).values({ email: `log-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    const [role] = await db.insert(roles).values({ name: `Registro ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: ["changelog.view"] }).returning({ id: roles.id });
    await db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, u!.id));
    const reader = (await app.inject({ method: "GET", url: "/api/change-log", headers: { cookie: await fullSessionCookie(app, u!.id) } })).json() as typeof log;
    const blind = reader.entries.filter((e) => e.type === "project.deleted" && e.hidden);
    expect(blind.length).toBeGreaterThan(0);
    expect(JSON.stringify(reader.entries)).not.toContain(p.projectId);
    expect(blind[0]!.data.object).toMatchObject({ id: "hidden", label: "" });
    // Un ex membro con `changelog.view` lo conosceva.
    await db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, p.lead.id));
    const former = (await app.inject({ method: "GET", url: "/api/change-log", headers: { cookie: p.lead.cookie } })).json() as typeof log;
    expect(former.entries.find((e) => e.type === "project.deleted" && e.data.object.id === p.projectId)).toMatchObject({ hidden: false, data: { object: { label: `${p.code} · Progetto di test` } } });
  });
});
