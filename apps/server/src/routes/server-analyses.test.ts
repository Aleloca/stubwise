import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { environmentServers, projectEnvironments, projectMembers, roles, serverAnalyses, serverCommands, servers } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
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

  it("servers.operate in un progetto del server, o monitor.manage: legge dal più recente, con l'autore; prima di una data", async () => {
    const { projectId, serverId } = await serverOfProject();
    const u = await createUserWithPat(app, `log-${randomBytes(3).toString("hex")}@acme.com`);
    await testDb.db.insert(projectMembers).values({ projectId, userId: u.id, roleId: operateRoleId });
    const older = await command(serverId, new Date("2026-11-10T10:00:00Z"));
    const newer = await command(serverId, new Date("2026-11-11T10:00:00Z"), u.id);
    const res = await log(serverId, u.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().commands.map((c: { id: string }) => c.id)).toEqual([newer, older]);
    expect(res.json().commands[0]).toMatchObject({ kind: "read", via: "agent", status: "done", output: "running", requestedBy: { id: u.id } });
    expect((await log(serverId, u.headers, "?before=2026-11-11T00:00:00.000Z")).json().commands.map((c: { id: string }) => c.id)).toEqual([older]);
    expect((await log(serverId, { cookie: users.adminCookie })).statusCode).toBe(200);
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
