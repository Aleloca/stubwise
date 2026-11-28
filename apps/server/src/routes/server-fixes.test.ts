import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { environmentServers, projectEnvironments, projectMembers, projects, roles, serverCommands, serverFixes, serverMetrics, serverOperationApprovals, servers, tickets, roleUpdate } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { issueServerCommand } from "@stubwise/notifications";
import { addMember, createUserWithPat, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * Area 8, F4b, S6: la correzione di una task di server. Approva SOLO chi ha
 * `plans.approve` NEL PROGETTO DELLA TASK (attribuito); un piano lo chiede
 * chi ha `servers.operate` lì; lo Stop revoca e cancella.
 * docs/invariants/server-operations.md.
 */

const KEY = randomBytes(32);
let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let operateRoleId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: KEY.toString("base64"), publicUrl: "https://stubwise.example.com" });
  users = await seedUsers(app);
  // Un operatore realistico: i permessi del Developer più servers.operate (nessun preset lo dà).
  const [dev] = await testDb.db.select({ permissions: roles.permissions }).from(roles).where(eq(roles.presetKey, "developer"));
  const [role] = await testDb.db
    .insert(roles)
    .values({ name: "Developer + server", scope: "project", permissions: [...dev!.permissions, "servers.operate"] })
    .returning();
  operateRoleId = role!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const restart = { action: "container.restart", params: { container: "web-a", timeoutSeconds: 10 }, why: "riparte" };

/** Un server di A (web-a) e B (db-b); la task in A con un piano in attesa. */
async function scene(opts: { operations?: boolean; steps?: object[] } = {}) {
  const [server] = await testDb.db
    .insert(servers)
    .values({ name: `s-${randomBytes(3).toString("hex")}`, keyHash: `h-${randomBytes(8).toString("hex")}`, agentCapabilities: { operations: opts.operations ?? true } })
    .returning();
  await testDb.db.insert(serverMetrics).values({
    serverId: server!.id,
    ts: new Date(),
    cpuPct: 1,
    load1m: 0,
    memUsedBytes: 1,
    memTotalBytes: 2,
    swapUsedBytes: 0,
    diskUsedBytes: 1,
    diskTotalBytes: 2,
    netRxBytes: 0,
    netTxBytes: 0,
    services: ["web-a", "db-b"].map((name) => ({ source: "docker", name, state: "running" })) as never,
  });
  const a = await seedRepository(testDb.db);
  const b = await seedRepository(testDb.db);
  const envs: string[] = [];
  for (const [p, c] of [
    [a, "web-a"],
    [b, "db-b"],
  ] as const) {
    const [env] = await testDb.db.insert(projectEnvironments).values({ projectId: p.projectId, name: "production", kind: "production", serverId: server!.id }).returning();
    await testDb.db.insert(environmentServers).values({ environmentId: env!.id, repositoryId: p.repositoryId, serverId: server!.id, containers: [c] });
    envs.push(env!.id);
  }
  const { ticketId } = await seedTicket(testDb.db, { projectId: a.projectId });
  const [fix] = await testDb.db
    .insert(serverFixes)
    .values({ taskId: ticketId, serverId: server!.id, projectId: a.projectId, status: "awaiting_approval", steps: (opts.steps ?? [restart]) as never })
    .returning();
  const user = async (projectId: string, preset: string | null) => {
    const u = await createUserWithPat(app, `u-${randomBytes(4).toString("hex")}@acme.com`);
    if (preset) await addMember(app, projectId, u.id, preset);
    else await testDb.db.insert(projectMembers).values({ projectId, userId: u.id, roleId: operateRoleId });
    return u;
  };
  return {
    serverId: server!.id,
    a,
    b,
    envs,
    ticketId,
    fix: fix!,
    leadA: await user(a.projectId, "project_lead"),
    leadB: await user(b.projectId, "project_lead"),
    devA: await user(a.projectId, "developer"),
    operA: await user(a.projectId, null),
  };
}

const call = (method: "GET" | "POST", ticketId: string, path: string, headers: Record<string, string>, payload?: object) =>
  app.inject({ method, url: `/api/tasks/${ticketId}/server-fix${path}`, headers, ...(payload ? { payload } : {}) });
/** Approva col digest della vista di chi approva (review F4b, I6). */
const approve = async (ticketId: string, headers: Record<string, string>) =>
  call("POST", ticketId, "/approve", headers, { planDigest: (await call("GET", ticketId, "", headers)).json().planDigest ?? "x" });
const approvalsOf = (ticketId: string) => testDb.db.select().from(serverOperationApprovals).where(eq(serverOperationApprovals.taskId, ticketId));

describe("la correzione: vista e approvazione", () => {
  it("la vista dice cosa può fare chi guarda (calcolato dal server)", async () => {
    const s = await scene();
    const dev = (await call("GET", s.ticketId, "", s.devA.headers)).json();
    expect(dev).toMatchObject({ status: "awaiting_approval", canApprove: false, canStop: false, canRequestPlan: false, operationsOn: true, pruneWarning: null });
    expect(dev.steps).toEqual([expect.objectContaining({ index: 0, action: "container.restart", status: "waiting" })]);
    expect((await call("GET", s.ticketId, "", s.leadA.headers)).json()).toMatchObject({ canApprove: true, canRequestPlan: false });
    // Un piano aspetta l'approvazione: niente richiesta nuova finché non lo si rifiuta (review F4b).
    expect((await call("GET", s.ticketId, "", s.operA.headers)).json()).toMatchObject({ canApprove: false, canRequestPlan: false });
  });

  it("NEGATIVO: un Developer, un Project Lead di un ALTRO progetto del server, un operatore senza plans.approve → nessuna approvazione", async () => {
    const s = await scene();
    expect((await approve(s.ticketId, s.devA.headers)).statusCode).toBe(403);
    expect((await approve(s.ticketId, s.leadB.headers)).statusCode).toBe(404);
    expect((await approve(s.ticketId, s.operA.headers)).statusCode).toBe(403);
    expect((await call("POST", s.ticketId, "/reject", s.devA.headers, { note: "no" })).statusCode).toBe(403);
    expect(await approvalsOf(s.ticketId)).toEqual([]);
    expect((await testDb.db.select().from(serverFixes).where(eq(serverFixes.id, s.fix.id)))[0]!.status).toBe("awaiting_approval");
  });

  it("plans.approve nel progetto della task: approvato, la copia ESATTA dei passi; una seconda volta → 409", async () => {
    const s = await scene();
    const res = await approve(s.ticketId, s.leadA.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "approved", approval: { by: { id: s.leadA.id } } });
    const [approval] = await approvalsOf(s.ticketId);
    expect(approval).toMatchObject({ serverId: s.serverId, approvedByUserId: s.leadA.id, revokedAt: null, steps: [restart] });
    expect((await approve(s.ticketId, s.leadA.headers)).statusCode).toBe(409);
  });

  it("un piano diventato stantio (il container ora è di un altro progetto) → 409 plan_stale, niente approvato", async () => {
    const s = await scene();
    await testDb.db.update(environmentServers).set({ containers: ["db-b", "web-a"] }).where(eq(environmentServers.environmentId, s.envs[1]!));
    const res = await approve(s.ticketId, s.leadA.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "plan_stale" });
    expect(await approvalsOf(s.ticketId)).toEqual([]);
  });

  it("review F4b, I6: si approva il piano VISTO; uno riscritto nel frattempo → 409 plan_changed, e nessuna approvazione orfana", async () => {
    const s = await scene();
    const seen = (await call("GET", s.ticketId, "", s.leadA.headers)).json().planDigest as string;
    expect(seen).toMatch(/^[0-9a-f]{64}$/);
    // Qualcuno fa proporre un piano diverso mentre la pagina è aperta.
    await testDb.db.update(serverFixes).set({ steps: [{ ...restart, params: { container: "web-a", timeoutSeconds: 60 } }] as never }).where(eq(serverFixes.id, s.fix.id));
    const res = await call("POST", s.ticketId, "/approve", s.leadA.headers, { planDigest: seen });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "plan_changed" });
    expect(await approvalsOf(s.ticketId)).toEqual([]);
    expect((await call("POST", s.ticketId, "/approve", s.leadA.headers, {})).statusCode).toBe(400);
  });

  it("il rifiuto con indicazioni", async () => {
    const s = await scene();
    const res = await call("POST", s.ticketId, "/reject", s.leadA.headers, { note: "prima guarda i log" });
    expect(res.json()).toMatchObject({ status: "rejected", rejection: { by: { id: s.leadA.id }, note: "prima guarda i log" } });
  });
});

describe("la correzione: piano nuovo e Stop", () => {
  it("un piano nuovo lo chiede chi ha servers.operate nel progetto; un Project Lead no; operazioni spente → 409", async () => {
    const s = await scene();
    // Con un piano che aspetta l'approvazione: 409 plan_awaiting, e il piano resta (review F4b).
    const awaiting = await call("POST", s.ticketId, "", s.operA.headers);
    expect(awaiting.statusCode).toBe(409);
    expect(awaiting.json()).toMatchObject({ code: "plan_awaiting" });
    expect((await testDb.db.select().from(serverFixes).where(eq(serverFixes.id, s.fix.id)))[0]!.steps).toEqual([restart]);
    await call("POST", s.ticketId, "/reject", s.leadA.headers, { note: "rifai" });
    expect((await call("POST", s.ticketId, "", s.leadA.headers)).statusCode).toBe(403);
    const res = await call("POST", s.ticketId, "", s.operA.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "proposing", steps: [] });
    expect((await call("POST", s.ticketId, "", s.operA.headers)).statusCode).toBe(409);
    const off = await scene({ operations: false });
    expect((await call("POST", off.ticketId, "", off.operA.headers)).json()).toMatchObject({ code: "operations_off" });
    // Operazioni spente: nessuna approvazione (canApprove falso, approve 409), e niente registrato (review F4b).
    expect((await call("GET", off.ticketId, "", off.leadA.headers)).json().canApprove).toBe(false);
    const offApprove = await approve(off.ticketId, off.leadA.headers);
    expect(offApprove.statusCode).toBe(409);
    expect(offApprove.json()).toMatchObject({ code: "operations_off" });
    expect(await approvalsOf(off.ticketId)).toEqual([]);
  });

  it("Stop: revoca l'approvazione e i comandi non consegnati non partono più; un Developer non può", async () => {
    const s = await scene();
    await approve(s.ticketId, s.leadA.headers);
    const [approval] = await approvalsOf(s.ticketId);
    const cmd = await issueServerCommand(testDb.db, KEY, { serverId: s.serverId, action: { action: "container.restart", params: { container: "web-a", timeoutSeconds: 10 } }, approval: { id: approval!.id, stepIndex: 0 } });
    await testDb.db.update(serverFixes).set({ status: "running", stepCommands: { "0": cmd.id } }).where(eq(serverFixes.id, s.fix.id));
    expect((await call("POST", s.ticketId, "/stop", s.devA.headers)).statusCode).toBe(403);
    const res = await call("POST", s.ticketId, "/stop", s.operA.headers);
    expect(res.json()).toMatchObject({ status: "stopped", steps: [expect.objectContaining({ status: "skipped" })] });
    expect((await approvalsOf(s.ticketId))[0]!.revokedAt).not.toBeNull();
    expect((await testDb.db.select().from(serverCommands).where(eq(serverCommands.id, cmd.id)))[0]!.status).toBe("cancelled");
    expect((await call("POST", s.ticketId, "/stop", s.operA.headers)).statusCode).toBe(409);
  });
});

describe("i comandi di una correzione, per task (richiesta del renderer)", () => {
  it("i passi delle sue approvazioni, con le uscite, a chi ha servers.operate nel progetto; un Project Lead senza → 403; vista con sessionId", async () => {
    const s = await scene();
    await approve(s.ticketId, s.leadA.headers);
    const [approval] = await approvalsOf(s.ticketId);
    const cmd = await issueServerCommand(testDb.db, KEY, { serverId: s.serverId, action: { action: "container.restart", params: { container: "web-a", timeoutSeconds: 10 } }, approval: { id: approval!.id, stepIndex: 0 } });
    // Una lettura di un'analisi sullo STESSO server non è di questa correzione.
    await issueServerCommand(testDb.db, KEY, { serverId: s.serverId, action: { action: "container.state", params: { container: "web-a" } } });
    const other = await scene();
    expect((await call("GET", s.ticketId, "/commands", s.operA.headers)).json().commands.map((c: { id: string }) => c.id)).toEqual([cmd.id]);
    expect((await call("GET", s.ticketId, "/commands", s.leadA.headers)).statusCode).toBe(403);
    expect((await call("GET", other.ticketId, "/commands", other.operA.headers)).json().commands).toEqual([]);
    expect((await call("GET", s.ticketId, "", s.devA.headers)).json()).toHaveProperty("sessionId", null);
  });
});

describe("la sezione Server della task (GET /api/tasks/:id/server, richiesta del renderer)", () => {
  const section = async (ticketId: string, headers: Record<string, string>) => app.inject({ method: "GET", url: `/api/tasks/${ticketId}/server`, headers });

  it("server, correzione e startBlock calcolati dal server", async () => {
    const s = await scene();
    const op = (await section(s.ticketId, s.operA.headers)).json();
    expect(op).toMatchObject({ server: { id: s.serverId, code: expect.stringMatching(/^SRV-\d+$/), gone: false }, fix: { status: "awaiting_approval" }, startBlock: "plan_awaiting" });
    await testDb.db.update(serverFixes).set({ status: "rejected" }).where(eq(serverFixes.id, s.fix.id));
    expect((await section(s.ticketId, s.operA.headers)).json().startBlock).toBeNull();
    expect((await section(s.ticketId, s.devA.headers)).json().startBlock).toBe("no_permission");
    // Una correzione in corso.
    await testDb.db.update(serverFixes).set({ status: "proposing" }).where(eq(serverFixes.id, s.fix.id));
    expect((await section(s.ticketId, s.operA.headers)).json().startBlock).toBe("busy");
    await testDb.db.update(serverFixes).set({ status: "none" }).where(eq(serverFixes.id, s.fix.id));
    // Task chiusa.
    await testDb.db.update(tickets).set({ ...roleUpdate("done") }).where(eq(tickets.id, s.ticketId));
    expect((await section(s.ticketId, s.operA.headers)).json().startBlock).toBe("closed");
  });

  it("operazioni spente; server non più nel progetto (gone); una task non da server → 404", async () => {
    const off = await scene({ operations: false });
    expect((await section(off.ticketId, off.operA.headers)).json().startBlock).toBe("operations_off");
    const s = await scene();
    await testDb.db.delete(environmentServers).where(eq(environmentServers.environmentId, s.envs[0]!));
    const gone = (await section(s.ticketId, s.operA.headers)).json();
    expect(gone).toMatchObject({ server: { gone: true }, startBlock: "server_not_in_project" });
    await testDb.db.delete(serverFixes).where(eq(serverFixes.id, s.fix.id));
    expect((await section(s.ticketId, s.operA.headers)).statusCode).toBe(404);
  });
});

describe("F4b-8 = c: la pulizia agisce su tutto il server", () => {
  it("l'avviso dice gli ALTRI progetti: il nome a chi li vede, il numero a chi no", async () => {
    const s = await scene({ steps: [{ action: "docker.prune", params: { what: "build_cache" }, why: "disco pieno" }] });
    const nameB = (await testDb.db.select({ name: projects.name }).from(projects).where(eq(projects.id, s.b.projectId)))[0]!.name;
    expect((await call("GET", s.ticketId, "", { cookie: users.adminCookie })).json().pruneWarning).toEqual({ projects: [nameB], hiddenCount: 0 });
    expect((await call("GET", s.ticketId, "", s.leadA.headers)).json().pruneWarning).toEqual({ projects: [], hiddenCount: 1 });
    // Un server di questo SOLO progetto: nessun avviso, null (review F4b, renderer).
    await testDb.db.delete(environmentServers).where(eq(environmentServers.environmentId, s.envs[1]!));
    expect((await call("GET", s.ticketId, "", s.leadA.headers)).json().pruneWarning).toBeNull();
    // E si approva comunque, con plans.approve nel progetto della task.
    expect((await approve(s.ticketId, s.leadA.headers)).statusCode).toBe(200);
  });
});
