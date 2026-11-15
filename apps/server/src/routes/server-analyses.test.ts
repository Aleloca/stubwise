import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { environmentServers, projectEnvironments, projectMembers, roles, serverAnalyses, serverCommands, serverOperationApprovals, servers, serverSshAccess } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { addMember, createUserWithPat, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Area 8, F4b, S5: l'analisi a mano di un server. La chiede chi ha
 * `servers.operate` in un progetto il cui ambiente usa il server (nessun
 * preset lo concede); una per server alla volta. Il run lo fa il worker.
 */

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let operateRoleId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  users = await seedUsers(app);
  const [role] = await testDb.db.insert(roles).values({ name: "Operatore server", scope: "project", permissions: ["servers.operate"] }).returning();
  operateRoleId = role!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function serverOfProject() {
  const { projectId, repositoryId } = await seedRepository(testDb.db);
  const [server] = await testDb.db.insert(servers).values({ name: `s-${randomBytes(3).toString("hex")}`, keyHash: `h-${randomBytes(8).toString("hex")}` }).returning();
  const [env] = await testDb.db.insert(projectEnvironments).values({ projectId, name: "production", kind: "production", serverId: server!.id }).returning();
  await testDb.db.insert(environmentServers).values({ environmentId: env!.id, repositoryId, serverId: server!.id });
  return { projectId, serverId: server!.id };
}

const start = (serverId: string, headers: Record<string, string>) => app.inject({ method: "POST", url: `/api/servers/${serverId}/analyses`, headers });

describe("POST /api/servers/:id/analyses", () => {
  it("con servers.operate in un progetto del server: 202, una riga in coda col suo autore; una seconda insieme → 409", async () => {
    const { projectId, serverId } = await serverOfProject();
    const u = await createUserWithPat(app, `op-${randomBytes(3).toString("hex")}@acme.com`);
    await testDb.db.insert(projectMembers).values({ projectId, userId: u.id, roleId: operateRoleId });
    const res = await start(serverId, u.headers);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ serverId, status: "running", episodeId: null, startedBy: { id: u.id } });
    const rows = await testDb.db.select().from(serverAnalyses).where(eq(serverAnalyses.serverId, serverId));
    expect(rows).toEqual([expect.objectContaining({ startedByUserId: u.id, sessionId: null, episodeId: null })]);
    const again = await start(serverId, u.headers);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "analysis_running" });
  });

  it("NEGATIVO: un Project Lead (nessun preset ha servers.operate) → 403; chi non vede il server → 404; servers.operate in un ALTRO progetto → 404; nessuna riga", async () => {
    const { projectId, serverId } = await serverOfProject();
    const { projectId: other } = await serverOfProject();
    const lead = await createUserWithPat(app, `lead-${randomBytes(3).toString("hex")}@acme.com`);
    await addMember(app, projectId, lead.id, "project_lead");
    expect((await start(serverId, lead.headers)).statusCode).toBe(403);
    const elsewhere = await createUserWithPat(app, `el-${randomBytes(3).toString("hex")}@acme.com`);
    await testDb.db.insert(projectMembers).values({ projectId: other, userId: elsewhere.id, roleId: operateRoleId });
    expect((await start(serverId, elsewhere.headers)).statusCode).toBe(404);
    expect((await start("00000000-0000-4000-8000-000000000000", elsewhere.headers)).statusCode).toBe(404);
    expect(await testDb.db.select().from(serverAnalyses).where(eq(serverAnalyses.serverId, serverId))).toEqual([]);
  });

  it("un full admin può (ha tutti i permessi su ogni progetto)", async () => {
    const { serverId } = await serverOfProject();
    expect((await start(serverId, { cookie: users.adminCookie })).statusCode).toBe(202);
  });
});

describe("GET /api/servers/:id/operations (S8, il registro)", () => {
  async function command(serverId: string, issuedAt: Date, requestedByUserId: string | null = null) {
    const expiresAt = new Date(issuedAt.getTime() + 600_000);
    const [c] = await testDb.db
      .insert(serverCommands)
      .values({ serverId, action: "container.state", params: { container: "web" }, kind: "read", issuedAt, expiresAt, requestedByUserId, status: "done", exitCode: 0, output: "running" })
      .returning();
    return c!.id;
  }
  const log = (serverId: string, headers: Record<string, string>, query = "") => app.inject({ method: "GET", url: `/api/servers/${serverId}/operations${query}`, headers });

  it("monitor.manage: legge dal più recente, con l'autore; prima di una data. servers.operate da solo: 200, ma i comandi senza una task che vede non ci sono (review F4b, I4)", async () => {
    const { projectId, serverId } = await serverOfProject();
    const u = await createUserWithPat(app, `log-${randomBytes(3).toString("hex")}@acme.com`);
    await testDb.db.insert(projectMembers).values({ projectId, userId: u.id, roleId: operateRoleId });
    const older = await command(serverId, new Date("2026-11-10T10:00:00Z"));
    const newer = await command(serverId, new Date("2026-11-11T10:00:00Z"), u.id);
    const admin = { cookie: users.adminCookie };
    const res = await log(serverId, admin);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().commands.map((c: { id: string }) => c.id)).toEqual([newer, older]);
    expect(res.json().commands[0]).toMatchObject({ kind: "read", via: "agent", status: "done", output: "running", requestedBy: { id: u.id } });
    expect((await log(serverId, admin, "?before=2026-11-11T00:00:00.000Z")).json().commands.map((c: { id: string }) => c.id)).toEqual([older]);
    const op = await log(serverId, u.headers);
    expect(op.statusCode).toBe(200);
    expect(op.json().commands).toEqual([]);
  });

  it("NEGATIVO: un Project Lead del progetto (senza servers.operate) → 403; chi non vede il server → 404", async () => {
    const { projectId, serverId } = await serverOfProject();
    await command(serverId, new Date());
    const lead = await createUserWithPat(app, `ll-${randomBytes(3).toString("hex")}@acme.com`);
    await addMember(app, projectId, lead.id, "project_lead");
    expect((await log(serverId, lead.headers)).statusCode).toBe(403);
    const stranger = await createUserWithPat(app, `st-${randomBytes(3).toString("hex")}@acme.com`);
    expect((await log(serverId, stranger.headers)).statusCode).toBe(404);
  });
});

describe("GET /api/servers/:id/analyses (S9)", () => {
  it("stato e attribuzione a chi vede il server; la diagnosi a monitor.manage e, se attribuita, a repos.view nel progetto attribuito", async () => {
    const { projectId: a, serverId } = await serverOfProject();
    // Un secondo progetto sullo stesso server.
    const { projectId: b, repositoryId: repoB } = await seedRepository(testDb.db);
    const [envB] = await testDb.db.insert(projectEnvironments).values({ projectId: b, name: "staging", kind: "staging", serverId }).returning();
    await testDb.db.insert(environmentServers).values({ environmentId: envB!.id, repositoryId: repoB, serverId });
    const { ticketId } = await seedTicket(testDb.db, { projectId: a });
    const [attributed] = await testDb.db
      .insert(serverAnalyses)
      .values({ serverId, status: "done", diagnosis: "OOM in web-a", attributedProjectId: a, taskId: ticketId, attribution: { result: { kind: "attributed" } }, startedAt: new Date("2026-11-14T10:00:00Z") })
      .returning();
    const [undetermined] = await testDb.db
      .insert(serverAnalyses)
      .values({ serverId, status: "done", diagnosis: "boh", attribution: { result: { kind: "undetermined", reason: "no_project" } }, startedAt: new Date("2026-11-14T11:00:00Z") })
      .returning();
    const devA = await createUserWithPat(app, `da-${randomBytes(3).toString("hex")}@acme.com`);
    await addMember(app, a, devA.id, "developer");
    const leadB = await createUserWithPat(app, `lb-${randomBytes(3).toString("hex")}@acme.com`);
    await addMember(app, b, leadB.id, "project_lead");
    const list = async (headers: Record<string, string>) => {
      const res = await app.inject({ method: "GET", url: `/api/servers/${serverId}/analyses`, headers });
      expect(res.statusCode, res.body).toBe(200);
      return new Map((res.json().analyses as { id: string }[]).map((x) => [x.id, x as Record<string, unknown>]));
    };
    const admin = await list({ cookie: users.adminCookie });
    expect(admin.get(attributed!.id)).toMatchObject({ diagnosis: "OOM in web-a", canViewDiagnosis: true, attribution: { kind: "attributed" }, taskCode: expect.stringMatching(/-\d+$/) });
    expect(admin.get(undetermined!.id)).toMatchObject({ diagnosis: "boh", canViewDiagnosis: true, attribution: { kind: "undetermined", reason: "no_project", projectCode: null } });
    const dev = await list(devA.headers);
    expect(dev.get(attributed!.id)).toMatchObject({ diagnosis: "OOM in web-a", canViewDiagnosis: true });
    expect(dev.get(undetermined!.id)).toMatchObject({ diagnosis: null, canViewDiagnosis: false, sessionId: null, status: "done" });
    const lead = await list(leadB.headers);
    expect(lead.get(attributed!.id)).toMatchObject({ diagnosis: null, canViewDiagnosis: false, taskCode: null, attribution: { kind: "attributed" } });
    const stranger = await createUserWithPat(app, `x-${randomBytes(3).toString("hex")}@acme.com`);
    expect((await app.inject({ method: "GET", url: `/api/servers/${serverId}/analyses`, headers: stranger.headers })).statusCode).toBe(404);
  });
});

describe("review F4b, I4: il registro come dice l'invariante", () => {
  it("senza monitor.manage solo i comandi legati a una task che vede, in un progetto dove ha servers.operate; monitor.manage tutto", async () => {
    const { projectId: a, serverId } = await serverOfProject();
    const { projectId: b, repositoryId: repoB } = await seedRepository(testDb.db);
    const [envB] = await testDb.db.insert(projectEnvironments).values({ projectId: b, name: "staging", kind: "staging", serverId }).returning();
    await testDb.db.insert(environmentServers).values({ environmentId: envB!.id, repositoryId: repoB, serverId });
    const { ticketId: taskA } = await seedTicket(testDb.db, { projectId: a });
    const { ticketId: taskB } = await seedTicket(testDb.db, { projectId: b });
    const step = { action: "container.restart", params: { container: "web", timeoutSeconds: 10 }, why: "x" };
    const command = async (taskId: string | null) => {
      const approvalId = taskId ? (await testDb.db.insert(serverOperationApprovals).values({ serverId, taskId, steps: [step] }).returning())[0]!.id : null;
      const values = approvalId
        ? { serverId, action: "container.restart", params: step.params, kind: "change" as const, approvalId, stepIndex: 0, expiresAt: new Date(Date.now() + 6e5), status: "done" as const }
        : { serverId, action: "container.state", params: { container: "web" }, kind: "read" as const, expiresAt: new Date(Date.now() + 6e5), status: "done" as const };
      return (await testDb.db.insert(serverCommands).values(values).returning())[0]!.id;
    };
    const onA = await command(taskA);
    const onB = await command(taskB);
    const noTask = await command(null);
    // Un operatore di A che vede tutte le task di A (Developer + servers.operate).
    const [dev] = await testDb.db.select({ permissions: roles.permissions }).from(roles).where(eq(roles.presetKey, "developer"));
    const [role] = await testDb.db.insert(roles).values({ name: `dev-op-${randomBytes(3).toString("hex")}`, scope: "project", permissions: [...dev!.permissions, "servers.operate"] }).returning();
    const opA = await createUserWithPat(app, `opa-${randomBytes(3).toString("hex")}@acme.com`);
    await testDb.db.insert(projectMembers).values({ projectId: a, userId: opA.id, roleId: role!.id });
    const ids = async (headers: Record<string, string>) =>
      ((await app.inject({ method: "GET", url: `/api/servers/${serverId}/operations`, headers })).json().commands as { id: string }[]).map((c) => c.id).sort();
    expect(await ids(opA.headers)).toEqual([onA]);
    expect(await ids({ cookie: users.adminCookie })).toEqual([onA, onB, noTask].sort());
  });
});

describe("review F4b: i campi della vista del server e dell'analisi calcolati dal server", () => {
  it("canStartAnalysis: sì all'operatore, no al Project Lead e mentre una a mano è in corso; agentOperations dalle capacità dichiarate", async () => {
    const { projectId, serverId } = await serverOfProject();
    await testDb.db.update(servers).set({ agentCapabilities: { operations: true } }).where(eq(servers.id, serverId));
    const op = await createUserWithPat(app, `cs-${randomBytes(3).toString("hex")}@acme.com`);
    await testDb.db.insert(projectMembers).values({ projectId, userId: op.id, roleId: operateRoleId });
    const lead = await createUserWithPat(app, `cl-${randomBytes(3).toString("hex")}@acme.com`);
    await addMember(app, projectId, lead.id, "project_lead");
    const detail = async (headers: Record<string, string>) => (await app.inject({ method: "GET", url: `/api/servers/${serverId}`, headers })).json();
    expect(await detail(op.headers)).toMatchObject({ canStartAnalysis: true, agentOperations: true });
    expect((await detail(lead.headers)).canStartAnalysis).toBe(false);
    expect((await start(serverId, op.headers)).statusCode).toBe(202);
    expect((await detail(op.headers)).canStartAnalysis).toBe(false);
  });

  it("endedBy `time` al tetto di durata; il codice di un progetto che chi guarda non vede non esce", async () => {
    const { projectId: a, serverId } = await serverOfProject();
    const { projectId: b, repositoryId: repoB } = await seedRepository(testDb.db);
    const [envB] = await testDb.db.insert(projectEnvironments).values({ projectId: b, name: "staging", kind: "staging", serverId }).returning();
    await testDb.db.insert(environmentServers).values({ environmentId: envB!.id, repositoryId: repoB, serverId });
    const [slow] = await testDb.db.insert(serverAnalyses).values({ serverId, status: "failed", attribution: { error: "tetto di durata (10 min)" } }).returning();
    const [toB] = await testDb.db.insert(serverAnalyses).values({ serverId, status: "done", attributedProjectId: b, attribution: { result: { kind: "attributed" } } }).returning();
    const lead = await createUserWithPat(app, `la-${randomBytes(3).toString("hex")}@acme.com`);
    await addMember(app, a, lead.id, "project_lead");
    const list = new Map(((await app.inject({ method: "GET", url: `/api/servers/${serverId}/analyses`, headers: lead.headers })).json().analyses as { id: string }[]).map((x) => [x.id, x as Record<string, unknown>]));
    expect(list.get(slow!.id)).toMatchObject({ endedBy: "time" });
    expect(list.get(toB!.id)).toMatchObject({ attribution: { kind: "attributed", projectCode: null } });
  });
});

describe("lo stato SSH nel dettaglio del server (richiesta del renderer)", () => {
  it("chiunque veda il server ne vede stato e usable, mai chiavi né verifica; senza accesso none", async () => {
    const { projectId, serverId } = await serverOfProject();
    const lead = await createUserWithPat(app, `sh-${randomBytes(3).toString("hex")}@acme.com`);
    await addMember(app, projectId, lead.id, "project_lead");
    const detail = async () => (await app.inject({ method: "GET", url: `/api/servers/${serverId}`, headers: lead.headers })).json();
    expect((await detail()).ssh).toEqual({ status: "none", usable: false });
    await testDb.db.insert(serverSshAccess).values({
      serverId,
      host: "h.example",
      publicKey: "ssh-ed25519 AAAA x",
      privateKeyEncrypted: "cifrata",
      status: "verified",
      hostKey: "SHA256:x",
      verifyResult: { groups: ["stubwise-read"], sudo: false, docker: false, journal: false, ok: true },
    });
    const body = await detail();
    expect(body.ssh).toEqual({ status: "verified", usable: true });
    expect(JSON.stringify(body)).not.toMatch(/ssh-ed25519|cifrata|stubwise-read/);
  });
});
