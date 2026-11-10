import { randomBytes } from "node:crypto";
import { aiJobs, notifications, personalAccessTokens, projectMembers, roles, ticketFollowers, tickets, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { personViewSchema } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { hashServerKey } from "./shared.js";
import { addMember, createUserWithSession, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Claude come collega assegnabile (integrazione area 3, fetta 3e; decisione
 * del maintainer del 10 nov 2026): un utente di sistema per istanza
 * (`users.is_agent`), senza accesso — login, sessione e PAT rifiutati per
 * costruzione — e senza notifiche. Assegnargli una task chiede `runs.start`
 * nel progetto e AVVIA il run come run-ai (stesse precondizioni, stesso gate
 * del piano); toglierlo non annulla niente.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let projectId: string;
let otherProjectId: string;
type U = { id: string; headers: { cookie: string } };
let developer: U;
let editorOnly: U;
let claudeId: string;
let n = 0;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  ({ projectId: otherProjectId } = await seedRepository(testDb.db));
  developer = await createUserWithSession(app, "dev-claude@example.com");
  editorOnly = await createUserWithSession(app, "editor@example.com");
  await addMember(app, projectId, developer.id, "developer");
  // Chi modifica le task ma NON avvia il lavoro (nessun preset è così: un ruolo apposta).
  const [role] = await testDb.db
    .insert(roles)
    .values({ name: "Solo modifica", scope: "project", permissions: ["tickets.view_all", "tickets.edit", "tickets.create"] })
    .returning({ id: roles.id });
  await testDb.db.insert(projectMembers).values({ projectId, userId: editorOnly.id, roleId: role!.id });
  const [claude] = await testDb.db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
  claudeId = claude!.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function task(pid = projectId): Promise<string> {
  n += 1;
  const [row] = await testDb.db
    .insert(tickets)
    .values({ projectId: pid, number: 6000 + n, title: `T${n}`, type: "bug", priority: "medium", source: "manual" })
    .returning({ id: tickets.id });
  return row!.id;
}

const req = (method: "GET" | "PATCH" | "POST", url: string, who: U, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.headers.cookie }, ...(payload ? { payload } : {}) });
const jobsOf = (ticketId: string) => testDb.db.select({ status: aiJobs.status }).from(aiJobs).where(eq(aiJobs.ticketId, ticketId));

describe("l'utente di sistema Claude", () => {
  it("è uno solo per istanza, senza accesso: login, sessione e PAT rifiutati", async () => {
    const agents = await testDb.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.isAgent, true));
    expect(agents).toHaveLength(1);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: agents[0]!.email, password: "qualsiasi" } });
    expect(login.statusCode).toBe(401);
    // Una sessione scritta a mano (secondo fattore compreso) non apre niente.
    const cookie = await fullSessionCookie(app, claudeId);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
    // Nemmeno un PAT.
    const token = `stw_pat_${randomBytes(16).toString("hex")}`;
    await testDb.db.insert(personalAccessTokens).values({ userId: claudeId, name: "x", tokenHash: hashServerKey(token) });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });

  it("/api/people lo include con isClaude, e dice in quali progetti chi guarda può assegnarlo (runs.start)", async () => {
    const forDev = z.array(personViewSchema).parse((await req("GET", "/api/people", developer)).json());
    expect(forDev.find((p) => p.id === claudeId)).toMatchObject({ isClaude: true, name: "Claude", claudeAssignableProjectIds: [projectId] });
    const forEditor = z.array(personViewSchema).parse((await req("GET", "/api/people", editorOnly)).json());
    expect(forEditor.find((p) => p.id === claudeId)).toMatchObject({ isClaude: true, claudeAssignableProjectIds: [] });
    // Le persone vere non sono «Claude».
    expect(forDev.filter((p) => p.isClaude)).toHaveLength(1);
  });
});

describe("assegnare Claude avvia il lavoro", () => {
  it("PATCH da chi ha runs.start: assegnato e un run parte (col gate: il developer non ha plans.approve); Claude non riceve notifiche", async () => {
    const t = await task();
    const res = await req("PATCH", `/api/tasks/${t}`, developer, { assigneeId: claudeId });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await testDb.db.select({ assigneeId: tickets.assigneeId }).from(tickets).where(eq(tickets.id, t));
    expect(row!.assigneeId).toBe(claudeId);
    const jobs = await testDb.db
      .select({ status: aiJobs.status, gate: aiJobs.planApprovalRequired, by: aiJobs.requestedByUserId })
      .from(aiJobs)
      .where(eq(aiJobs.ticketId, t));
    expect(jobs).toEqual([{ status: "queued", gate: true, by: developer.id }]);
    expect(await testDb.db.select().from(notifications).where(eq(notifications.userId, claudeId))).toEqual([]);
  });

  it("chi non ha runs.start non può assegnarlo: 403 e niente cambia", async () => {
    const t = await task();
    const res = await req("PATCH", `/api/tasks/${t}`, editorOnly, { assigneeId: claudeId });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ code: "claude_assign_forbidden" });
    const [row] = await testDb.db.select({ assigneeId: tickets.assigneeId }).from(tickets).where(eq(tickets.id, t));
    expect(row!.assigneeId).toBeNull();
    expect(await jobsOf(t)).toEqual([]);
  });

  it("in blocco e dal Planning: stessa regola; creata già assegnata: parte", async () => {
    const [a, b] = [await task(), await task()];
    expect((await req("PATCH", "/api/tasks/bulk", editorOnly, { ids: [a], patch: { assigneeId: claudeId } })).statusCode).toBe(403);
    expect(await jobsOf(a)).toEqual([]);
    const bulk = await req("PATCH", "/api/tasks/bulk", developer, { ids: [a, b], patch: { assigneeId: claudeId } });
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect((await jobsOf(a)).length).toBe(1);
    expect((await jobsOf(b)).length).toBe(1);
    const c = await task();
    const plan = await req("POST", `/api/tasks/${c}/plan`, developer, { assigneeId: claudeId, week: null });
    expect(plan.statusCode, plan.body).toBe(200);
    expect((await jobsOf(c)).length).toBe(1);
    const created = await req("POST", "/api/tasks", developer, { projectId, title: "Nuova per Claude", type: "bug", assigneeId: claudeId });
    expect(created.statusCode, created.body).toBe(201);
    expect((await jobsOf((created.json() as { id: string }).id)).length).toBe(1);
  });

  it("riassegnarlo con un lavoro già in corso non ne avvia un altro; toglierlo non annulla niente", async () => {
    const t = await task();
    expect((await req("PATCH", `/api/tasks/${t}`, developer, { assigneeId: claudeId })).statusCode).toBe(200);
    expect((await req("PATCH", `/api/tasks/${t}`, developer, { assigneeId: null })).statusCode).toBe(200);
    expect(await jobsOf(t)).toEqual([{ status: "queued" }]);
    expect((await req("PATCH", `/api/tasks/${t}`, developer, { assigneeId: claudeId })).statusCode).toBe(200);
    expect(await jobsOf(t)).toEqual([{ status: "queued" }]);
  });

  it("in un progetto dove chi assegna non è membro, Claude non si assegna (404 come ogni task invisibile)", async () => {
    const t = await task(otherProjectId);
    expect((await req("PATCH", `/api/tasks/${t}`, developer, { assigneeId: claudeId })).statusCode).toBe(404);
    expect(
      await testDb.db.select().from(tickets).where(and(eq(tickets.id, t), eq(tickets.assigneeId, claudeId))),
    ).toEqual([]);
  });
});

describe("l'esito dell'avvio arriva nella risposta (claudeRun)", () => {
  it("assegnato e partito: started; con un lavoro già in corso: refused:job_in_flight; una task non assegnata a Claude non lo porta", async () => {
    const t = await task();
    const ok = await req("PATCH", `/api/tasks/${t}`, developer, { assigneeId: claudeId });
    expect(ok.json()).toMatchObject({ claudeRun: "started" });
    const busy = await task();
    await testDb.db.insert(aiJobs).values({ ticketId: busy, status: "fixing" });
    const refused = await req("PATCH", `/api/tasks/${busy}`, developer, { assigneeId: claudeId });
    expect(refused.statusCode, refused.body).toBe(200);
    expect(refused.json()).toMatchObject({ assigneeId: claudeId, claudeRun: "refused:job_in_flight" });
    const plain = await req("PATCH", `/api/tasks/${await task()}`, developer, { title: "x" });
    expect(plain.json()).toMatchObject({ claudeRun: null });
    // Dal Planning e alla creazione, lo stesso campo.
    const viaPlan = await req("POST", `/api/tasks/${await task()}/plan`, developer, { assigneeId: claudeId, week: null });
    expect(viaPlan.json()).toMatchObject({ claudeRun: "started" });
    const created = await req("POST", "/api/tasks", developer, { projectId, title: "Nuova", type: "bug", assigneeId: claudeId });
    expect(created.json()).toMatchObject({ claudeRun: "started" });
  });
});

describe("pianificare Claude chiede anche di poter modificare, e una task aperta", () => {
  it("con runs.start ma senza tickets.edit: 403 forbidden e niente cambia; su una task chiusa: 403 forbidden e nessun run", async () => {
    const runner = await createUserWithSession(app, "runner-only@example.com");
    const [role] = await testDb.db
      .insert(roles)
      .values({ name: "Solo avvio", scope: "project", permissions: ["tickets.view_all", "runs.start", "planning.others"] })
      .returning({ id: roles.id });
    await testDb.db.insert(projectMembers).values({ projectId, userId: runner.id, roleId: role!.id });
    const t = await task();
    const refused = await req("POST", `/api/tasks/${t}/plan`, runner, { assigneeId: claudeId, week: null });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ code: "forbidden" });
    expect(await jobsOf(t)).toEqual([]);
    const closed = await task();
    await testDb.db.update(tickets).set({ closedAt: new Date(), status: "done" }).where(eq(tickets.id, closed));
    const onClosed = await req("POST", `/api/tasks/${closed}/plan`, developer, { assigneeId: claudeId, week: null });
    expect(onClosed.statusCode, onClosed.body).toBe(403);
    const [row] = await testDb.db.select({ assigneeId: tickets.assigneeId }).from(tickets).where(eq(tickets.id, closed));
    expect(row!.assigneeId).toBeNull();
    expect(await jobsOf(closed)).toEqual([]);
  });
});

describe("le porte vecchie (web vecchio, mobile, MCP) seguono la stessa regola", () => {
  it("PATCH /api/tickets/:id: senza runs.start 403 claude_assign_forbidden e niente cambia; con runs.start assegnato e il run parte", async () => {
    const t = await task();
    const refused = await req("PATCH", `/api/tickets/${t}`, editorOnly, { assigneeId: claudeId });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ code: "claude_assign_forbidden" });
    const [row] = await testDb.db.select({ assigneeId: tickets.assigneeId }).from(tickets).where(eq(tickets.id, t));
    expect(row!.assigneeId).toBeNull();
    expect(await jobsOf(t)).toEqual([]);
    const ok = await req("PATCH", `/api/tickets/${t}`, developer, { assigneeId: claudeId });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await jobsOf(t)).length).toBe(1);
  });

  it("POST /api/tickets già assegnato a Claude: senza runs.start 403 e niente nasce; con runs.start nasce e il run parte", async () => {
    const before = (await testDb.db.select({ id: tickets.id }).from(tickets)).length;
    const refused = await req("POST", "/api/tickets", editorOnly, { projectId, title: "Vecchia porta", type: "bug", priority: "medium", assigneeId: claudeId });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ code: "claude_assign_forbidden" });
    expect((await testDb.db.select({ id: tickets.id }).from(tickets)).length).toBe(before);
    const ok = await req("POST", "/api/tickets", developer, { projectId, title: "Vecchia porta", type: "bug", priority: "medium", assigneeId: claudeId });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await jobsOf((ok.json() as { id: string }).id)).length).toBe(1);
  });
});

describe("Claude non è una persona da gestire", () => {
  it("non è nel Team; le rotte /api/users/:id su di lui rispondono 404", async () => {
    const admin = await createUserWithSession(app, "admin-claude@example.com");
    await testDb.db
      .update(users)
      .set({ instanceRoleId: (await testDb.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "admin")))[0]!.id })
      .where(eq(users.id, admin.id));
    const list = await req("GET", "/api/users", admin);
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { id: string }[]).some((u) => u.id === claudeId)).toBe(false);
    const events = await req("GET", `/api/users/${claudeId}/security-events`, admin);
    expect(events.statusCode).toBe(404);
  });
});

describe("Claude non riceve mai notifiche", () => {
  it("nemmeno da membro e follower di un progetto (dato scritto a mano): l'esclusione sta in publishNotification", async () => {
    const t = await task();
    const [dev] = await testDb.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
    await testDb.db.insert(projectMembers).values({ projectId, userId: claudeId, roleId: dev!.id }).onConflictDoNothing();
    await testDb.db.insert(ticketFollowers).values({ ticketId: t, userId: claudeId }).onConflictDoNothing();
    const comment = await req("POST", `/api/tickets/${t}/comments`, developer, { body: "Ci guardo io" });
    expect(comment.statusCode, comment.body).toBe(201);
    expect(await testDb.db.select().from(notifications).where(eq(notifications.userId, claudeId))).toEqual([]);
    await testDb.db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, claudeId)));
  });

  it("non si aggiunge come membro di un progetto (404, come un utente che non c'è)", async () => {
    const admin = await createUserWithSession(app, "admin-members@example.com");
    await testDb.db
      .update(users)
      .set({ instanceRoleId: (await testDb.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "admin")))[0]!.id })
      .where(eq(users.id, admin.id));
    const [dev] = await testDb.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/members/${claudeId}`,
      headers: { cookie: admin.headers.cookie },
      payload: { roleId: dev!.id },
    });
    expect(res.statusCode, res.body).toBe(404);
  });
});
