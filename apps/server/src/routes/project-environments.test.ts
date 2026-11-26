import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { environmentServers, projectEnvironments, serverMetrics, servers } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedEnvironment, seedRepository as seedRepositoryRaw, seedRepositoryInProject, startTestDb } from "@stubwise/db/testing";
import { seedUsers, addMember, createUserWithPat } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const ENCRYPTION_KEY = randomBytes(32);

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let memberId: string;
let projectId: string;

const MISSING_UUID = "00000000-0000-0000-0000-000000000000";

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: ENCRYPTION_KEY.toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  ({ adminCookie, memberCookie, memberId } = await seedUsers(app));
  ({ projectId } = await seedRepository(testDb.db));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/**
 * Come `seedRepository`, e il member del file diventa Legacy Member del
 * progetto (quello che ogni `member` ha dopo la conversione): un progetto di
 * cui non è membro gli risponderebbe 404.
 */
async function seedRepository(db: TestDb["db"]) {
  const seeded = await seedRepositoryRaw(db);
  await addMember(app, seeded.projectId, memberId);
  return seeded;
}

function createEnvironment(
  body: { name: string; kind: string; url?: string | null; serverId?: string | null },
  cookie = adminCookie,
  pid = projectId,
) {
  return app.inject({
    method: "POST",
    url: `/api/projects/${pid}/environments`,
    headers: { cookie },
    payload: body,
  });
}

describe("GET /api/projects/:projectId/environments", () => {
  it("lista vuota per un progetto nuovo senza ambienti extra oltre `test` — qui il progetto è isolato dal seed", async () => {
    const { projectId: freshProjectId } = await seedRepository(testDb.db);
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${freshProjectId}/environments`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("un member può leggere (non è un segreto, solo anagrafica)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/environments`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/environments`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("progetto inesistente: 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${MISSING_UUID}/environments`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/projects/:projectId/environments — cosa gira (fase 8, Task 4)", () => {
  it("ambiente collegato a un server con un servizio OMONIMO: runningImage/runningCommitSha valorizzati", async () => {
    const [server] = await testDb.db
      .insert(servers)
      .values({ name: "vps-running", keyHash: `hash-${crypto.randomUUID()}` })
      .returning();
    const created = await createEnvironment({ name: "staging-running", kind: "staging", serverId: server!.id });
    const environmentId = (created.json() as { id: string }).id;

    await testDb.db.insert(serverMetrics).values({
      serverId: server!.id,
      ts: new Date(),
      cpuPct: 1,
      load1m: 0.1,
      memUsedBytes: 1000,
      memTotalBytes: 2000,
      swapUsedBytes: 0,
      diskUsedBytes: 1000,
      diskTotalBytes: 2000,
      netRxBytes: 0,
      netTxBytes: 0,
      services: [
        {
          source: "docker",
          // STESSO nome dell'ambiente: è la convenzione di matching.
          name: "staging-running",
          state: "running",
          cpuPct: 1,
          memBytes: 1000,
          restarts: null,
          image: "acme/web:2.0.0",
          commitSha: "def5678",
        },
        {
          source: "docker",
          name: "un-altro-servizio",
          state: "running",
          cpuPct: 1,
          memBytes: 1000,
          restarts: null,
          image: "acme/other:1.0.0",
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/environments`,
      headers: { cookie: adminCookie },
    });
    const found = (res.json() as { id: string; runningImage?: string; runningCommitSha?: string }[]).find(
      (e) => e.id === environmentId,
    );
    expect(found).toMatchObject({ runningImage: "acme/web:2.0.0", runningCommitSha: "def5678" });
  });

  it("nessun servizio con quel nome sul server: i campi restano ASSENTI, non un errore", async () => {
    const [server] = await testDb.db
      .insert(servers)
      .values({ name: "vps-no-match", keyHash: `hash-${crypto.randomUUID()}` })
      .returning();
    const created = await createEnvironment({ name: "prod-no-match", kind: "production", serverId: server!.id });
    const environmentId = (created.json() as { id: string }).id;

    await testDb.db.insert(serverMetrics).values({
      serverId: server!.id,
      ts: new Date(),
      cpuPct: 1,
      load1m: 0.1,
      memUsedBytes: 1000,
      memTotalBytes: 2000,
      swapUsedBytes: 0,
      diskUsedBytes: 1000,
      diskTotalBytes: 2000,
      netRxBytes: 0,
      netTxBytes: 0,
      services: [{ source: "docker", name: "nome-diverso", state: "running", cpuPct: 1, memBytes: 1000, restarts: null }],
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/environments`,
      headers: { cookie: adminCookie },
    });
    const found = (res.json() as { id: string; runningImage?: string; runningCommitSha?: string }[]).find(
      (e) => e.id === environmentId,
    );
    expect(found).toBeDefined();
    expect(found).not.toHaveProperty("runningImage");
    expect(found).not.toHaveProperty("runningCommitSha");
  });

  it("nessun server collegato: i campi restano ASSENTI (nessuna query di servizio nemmeno tentata)", async () => {
    const created = await createEnvironment({ name: "staging-no-server", kind: "staging" });
    const environmentId = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/environments`,
      headers: { cookie: adminCookie },
    });
    const found = (res.json() as { id: string; runningImage?: string }[]).find((e) => e.id === environmentId);
    expect(found?.runningImage).toBeUndefined();
  });
});

describe("POST /api/projects/:projectId/environments", () => {
  it("l'admin crea un ambiente: 201 con id/projectId/name/kind/url/serverId", async () => {
    const res = await createEnvironment({ name: "staging", kind: "staging", url: "https://staging.acme.test" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: expect.any(String),
      projectId,
      name: "staging",
      kind: "staging",
      url: "https://staging.acme.test",
      serverId: null,
    });
  });

  it("url/serverId assenti → null", async () => {
    // Uno staging: il progetto di questi test ha già la sua (unica, [R 12]) produzione.
    const res = await createEnvironment({ name: "stg-null", kind: "staging" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ url: null, serverId: null, servers: [] });
  });

  it("serverId di un server esistente: collegato", async () => {
    const [server] = await testDb.db
      .insert(servers)
      .values({ name: "vps-env-test", keyHash: `hash-${crypto.randomUUID()}` })
      .returning();
    const res = await createEnvironment({ name: "staging-eu", kind: "staging", serverId: server!.id });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ serverId: server!.id });
  });

  it("serverId inesistente: 400", async () => {
    const res = await createEnvironment({ name: "staging-bad-server", kind: "staging", serverId: MISSING_UUID });
    expect(res.statusCode).toBe(400);
  });

  it("nome duplicato sullo stesso progetto: 409", async () => {
    await createEnvironment({ name: "staging-dup", kind: "staging" });
    const again = await createEnvironment({ name: "staging-dup", kind: "production" });
    expect(again.statusCode).toBe(409);
  });

  it("un secondo ambiente kind='test', anche con nome diverso: 409 test_environment_exists — non 'nome già in uso' (review fix Task 3)", async () => {
    // Progetto isolato: gli altri test di questo blocco condividono
    // `projectId` e un kind='test' lì resterebbe per il resto del file.
    const { projectId: freshProjectId } = await seedRepository(testDb.db);
    const first = await createEnvironment({ name: "test", kind: "test" }, adminCookie, freshProjectId);
    expect(first.statusCode).toBe(201);

    // Nome DIVERSO: l'unique su (project_id, name) non lo vieterebbe da solo.
    const second = await createEnvironment(
      { name: "test-secondario", kind: "test" },
      adminCookie,
      freshProjectId,
    );
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "test_environment_exists" });
  });

  it("kind fuori enum: 400 (validazione Zod)", async () => {
    const res = await createEnvironment({ name: "canary", kind: "canary" });
    expect(res.statusCode).toBe(400);
  });

  it("progetto inesistente: 404", async () => {
    const res = await createEnvironment({ name: "x", kind: "test" }, adminCookie, MISSING_UUID);
    expect(res.statusCode).toBe(404);
  });

  it("un member non può creare: 403", async () => {
    const res = await createEnvironment({ name: "staging-member", kind: "staging" }, memberCookie);
    expect(res.statusCode).toBe(403);
  });

  it("senza sessione: 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/environments`,
      payload: { name: "x", kind: "test" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/projects/:projectId/environments/:environmentId", () => {
  it("aggiorna nome/url/serverId; kind resta invariato anche se il body lo tenta", async () => {
    const created = await createEnvironment({ name: "to-patch", kind: "staging" });
    const environmentId = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: adminCookie },
      // `kind` non è nello schema di patch: passarlo non deve cambiarlo.
      payload: { name: "patched", url: "https://patched.acme.test", kind: "production" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "patched", url: "https://patched.acme.test", kind: "staging" });
  });

  it("campi assenti restano invariati (vera PATCH)", async () => {
    const created = await createEnvironment({ name: "to-patch-partial", kind: "staging", url: "https://a.test" });
    const environmentId = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: adminCookie },
      payload: { name: "renamed-only" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "renamed-only", url: "https://a.test" });
  });

  it("url: null azzera esplicitamente", async () => {
    const created = await createEnvironment({ name: "to-clear-url", kind: "staging", url: "https://a.test" });
    const environmentId = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: adminCookie },
      payload: { url: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: null });
  });

  it("ambiente inesistente: 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${MISSING_UUID}`,
      headers: { cookie: adminCookie },
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può modificare: 403", async () => {
    const created = await createEnvironment({ name: "to-patch-member", kind: "staging" });
    const environmentId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: memberCookie },
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/projects/:projectId/environments/:environmentId", () => {
  it("elimina un ambiente non-test: 204", async () => {
    const created = await createEnvironment({ name: "to-delete", kind: "staging" });
    const environmentId = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);

    const rows = await testDb.db
      .select()
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, environmentId));
    expect(rows).toHaveLength(0);
  });

  it("l'ambiente `test` NON si cancella: 409, riga intatta", async () => {
    const testEnvironmentId = await seedEnvironment(testDb.db, projectId, { name: "test-protetto", kind: "test" });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/environments/${testEnvironmentId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "test_environment_immutable" });

    const rows = await testDb.db
      .select()
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, testEnvironmentId));
    expect(rows).toHaveLength(1);
  });

  it("ambiente inesistente: 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/environments/${MISSING_UUID}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("un member non può eliminare: 403", async () => {
    const created = await createEnvironment({ name: "to-delete-member", kind: "staging" });
    const environmentId = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/environments/${environmentId}`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(403);

    const rows = await testDb.db
      .select()
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, environmentId));
    expect(rows).toHaveLength(1);
  });
});

describe("ambienti per repository (area 8, F1, R-L2)", () => {
  async function newServer(name: string) {
    const [srv] = await testDb.db.insert(servers).values({ name: `${name}-${crypto.randomUUID().slice(0, 6)}`, keyHash: `hash-${crypto.randomUUID()}` }).returning();
    return srv!.id;
  }
  const post = (pid: string, payload: object) => app.inject({ method: "POST", url: `/api/projects/${pid}/environments`, headers: { cookie: adminCookie }, payload });
  const patch = (pid: string, id: string, payload: object) => app.inject({ method: "PATCH", url: `/api/projects/${pid}/environments/${id}`, headers: { cookie: adminCookie }, payload });
  const sorted = (xs: { repositoryId: string; serverId: string }[]) => [...xs].sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));

  it("serverId (forma di prima) vale per tutte le repository; servers lo sovrascrive per quella che nomina", async () => {
    const { projectId: pid, repositoryId: r1 } = await seedRepository(testDb.db);
    const r2 = await seedRepositoryInProject(testDb.db, pid);
    const a = await newServer("a");
    const b = await newServer("b");
    const res = await post(pid, { name: "production", kind: "production", serverId: a, servers: [{ repositoryId: r2, serverId: b }] });
    expect(res.statusCode).toBe(201);
    expect(sorted(res.json().servers)).toEqual(sorted([{ repositoryId: r1, serverId: a }, { repositoryId: r2, serverId: b }]));
    // PATCH: null toglie il server della sola r1.
    const upd = await patch(pid, res.json().id, { servers: [{ repositoryId: r1, serverId: null }] });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().servers).toEqual([{ repositoryId: r2, serverId: b }]);
    // E la GET dice lo stesso.
    const list = await app.inject({ method: "GET", url: `/api/projects/${pid}/environments`, headers: { cookie: adminCookie } });
    const listed = list.json().find((e: { id: string }) => e.id === res.json().id).servers as { repositoryId: string; serverId: string }[];
    expect(listed.map(({ repositoryId, serverId }) => ({ repositoryId, serverId }))).toEqual([{ repositoryId: r2, serverId: b }]);
  });

  it("una repository di un altro progetto: 400 bad_servers, e niente scritto", async () => {
    const { projectId: pid } = await seedRepository(testDb.db);
    const { repositoryId: foreign } = await seedRepository(testDb.db);
    const res = await post(pid, { name: "staging", kind: "staging", servers: [{ repositoryId: foreign, serverId: await newServer("c") }] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "bad_servers" });
    expect(await testDb.db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, pid))).toEqual([]);
  });

  it("area 8, F1: per repository il nome del server, il commit riportato (quello di un rilascio della repository, se c'è) e il codice del rilascio; per ambiente canManage e onlyHere", async () => {
    const { releases, serverMetrics } = await import("@stubwise/db");
    const { projectId: pid, repositoryId: r1 } = await seedRepository(testDb.db);
    const r2 = await seedRepositoryInProject(testDb.db, pid);
    const mine = await newServer("solo-qui");
    const shared = await newServer("condiviso");
    const res = await post(pid, { name: "production", kind: "production", servers: [{ repositoryId: r1, serverId: mine }, { repositoryId: r2, serverId: shared }] });
    expect(res.statusCode).toBe(201);
    // Il server condiviso lo usa anche un altro progetto.
    const { projectId: other } = await seedRepository(testDb.db);
    expect((await post(other, { name: "production", kind: "production", serverId: shared })).statusCode).toBe(201);
    // Su `mine` gira il commit di un rilascio di r1; su `shared` un commit qualunque, ma col nome dell'ambiente.
    const sha = "d".repeat(40);
    await testDb.db.insert(releases).values({ code: `ENV${crypto.randomUUID().slice(0, 3).toUpperCase()}-V1`, seq: 1, projectId: pid, repositoryId: r1, prNumber: 1, prUrl: "u", title: "t", mergeSha: sha, mergedAt: new Date(), viaStubwise: true });
    const sample = (serverId: string, services: object[]) =>
      testDb.db.insert(serverMetrics).values({ serverId, ts: new Date("2026-11-13T10:00:00Z"), cpuPct: 1, load1m: 0, memUsedBytes: 1, memTotalBytes: 2, swapUsedBytes: 0, diskUsedBytes: 0, diskTotalBytes: 1, netRxBytes: 0, netTxBytes: 0, disks: [], services } as never);
    await sample(mine, [{ source: "docker", name: "web", state: "running", cpuPct: 0, memBytes: 0, restarts: null, image: "x", commitSha: sha.slice(0, 12) }]);
    await sample(shared, [{ source: "docker", name: "production", state: "running", cpuPct: 0, memBytes: 0, restarts: null, image: "y", commitSha: "e".repeat(12) }]);

    const list = await app.inject({ method: "GET", url: `/api/projects/${pid}/environments`, headers: { cookie: adminCookie } });
    const env = (list.json() as Record<string, unknown>[]).find((e) => e["id"] === res.json().id) as { servers: Record<string, unknown>[]; canManage: boolean; onlyHere: string[] };
    const row = (repositoryId: string) => env.servers.find((x) => x["repositoryId"] === repositoryId);
    expect(row(r1)).toMatchObject({ serverId: mine, serverName: expect.stringMatching(/^solo-qui-/), reportedSha: sha.slice(0, 12), reportedAt: "2026-11-13T10:00:00.000Z", releaseCode: expect.stringMatching(/-V1$/) });
    expect(row(r2)).toMatchObject({ serverId: shared, reportedSha: "e".repeat(12), releaseCode: null });
    expect(env.canManage).toBe(true);
    expect(env.onlyHere).toEqual([mine]);
    // Un member senza environments.manage: lo vede, ma non lo gestisce.
    const asMember = await app.inject({ method: "GET", url: `/api/projects/${pid}/environments`, headers: { cookie: memberCookie } });
    expect((asMember.json() as { id: string; canManage: boolean }[]).find((e) => e.id === res.json().id)!.canManage).toBe(false);
  });

  it("una seconda produzione nello stesso progetto: 409 production_environment_exists", async () => {
    const { projectId: pid } = await seedRepository(testDb.db);
    expect((await post(pid, { name: "prod", kind: "production" })).statusCode).toBe(201);
    const again = await post(pid, { name: "prod-2", kind: "production" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "production_environment_exists" });
  });
});

// Area 8, F4a, S3: con la visibilità dai server degli AMBIENTI, collegare un
// server a un ambiente lo fa vedere a tutto il progetto. Si collega solo un
// server che chi scrive vede già (o con monitor.manage): niente scritto,
// altrimenti.
describe("area 8, F4a, S3: un collegamento non allarga la visibilità", () => {
  it("un Project Lead con environments.manage non collega un server che non vede (POST e PATCH); lo collega se lo vede; l'admin sempre", async () => {
    const { projectId: pid, repositoryId } = await seedRepositoryRaw(testDb.db);
    const { projectId: otherPid, repositoryId: otherRepo } = await seedRepositoryRaw(testDb.db);
    const lead = await createUserWithPat(app, `lead-${randomBytes(3).toString("hex")}@acme.com`);
    await addMember(app, pid, lead.id, "project_lead");
    const [hidden] = await testDb.db.insert(servers).values({ name: "di-altri", keyHash: `h-${randomBytes(4).toString("hex")}` }).returning();
    const [seen] = await testDb.db.insert(servers).values({ name: "suo", keyHash: `h-${randomBytes(4).toString("hex")}` }).returning();
    // `seen` lo usa già un ambiente del progetto del lead; `hidden` solo un progetto altrui.
    const envSeen = await seedEnvironment(testDb.db, pid, { name: "staging", kind: "staging" });
    const envHidden = await seedEnvironment(testDb.db, otherPid, { name: "production", kind: "production" });
    await testDb.db.insert(environmentServers).values([
      { environmentId: envSeen, repositoryId, serverId: seen!.id },
      { environmentId: envHidden, repositoryId: otherRepo, serverId: hidden!.id },
    ]);

    const post = (headers: Record<string, string>, body: object) =>
      app.inject({ method: "POST", url: `/api/projects/${pid}/environments`, headers, payload: body });
    const refused = await post(lead.headers, { name: "prod", kind: "production", servers: [{ repositoryId, serverId: hidden!.id }] });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: "server_not_visible" });
    expect((await post(lead.headers, { name: "prod-2", kind: "production", serverId: hidden!.id })).statusCode).toBe(422);
    expect(await testDb.db.select().from(projectEnvironments).where(eq(projectEnvironments.projectId, pid))).toHaveLength(1);

    const ok = await post(lead.headers, { name: "prod", kind: "production", servers: [{ repositoryId, serverId: seen!.id }] });
    expect(ok.statusCode, ok.body).toBe(201);
    const envId = (ok.json() as { id: string }).id;
    const patch = (headers: Record<string, string>, body: object) =>
      app.inject({ method: "PATCH", url: `/api/projects/${pid}/environments/${envId}`, headers, payload: body });
    expect((await patch(lead.headers, { servers: [{ repositoryId, serverId: hidden!.id }] })).statusCode).toBe(422);
    // Togliere un server (null) non chiede niente.
    expect((await patch(lead.headers, { servers: [{ repositoryId, serverId: null }] })).statusCode).toBe(200);
    // L'admin (monitor.manage) collega qualunque server.
    expect((await patch({ cookie: adminCookie }, { servers: [{ repositoryId, serverId: hidden!.id }] })).statusCode).toBe(200);
  });
});

// Review F4a, I2: un server inesistente e uno invisibile rispondono uguale
// (422 server_not_visible) a chi non vede tutti i server.
describe("review F4a: inesistente = invisibile nel collegamento", () => {
  it("un Project Lead riceve 422 server_not_visible per un id che non esiste", async () => {
    const { projectId: pid, repositoryId } = await seedRepositoryRaw(testDb.db);
    const lead = await createUserWithPat(app, `lead2-${randomBytes(3).toString("hex")}@acme.com`);
    await addMember(app, pid, lead.id, "project_lead");
    const missing = "00000000-0000-4000-8000-0000000000aa";
    for (const body of [{ name: "a", kind: "production", serverId: missing }, { name: "b", kind: "staging", servers: [{ repositoryId, serverId: missing }] }]) {
      const res = await app.inject({ method: "POST", url: `/api/projects/${pid}/environments`, headers: lead.headers, payload: body });
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(res.json()).toMatchObject({ code: "server_not_visible" });
    }
  });
});


// Area 8, F4a (richiesta di 94): il codice `SRV-<n>` dei server dell'ambiente,
// per repository e per l'ambiente intero (`serverId`), additivo.
describe("area 8, F4a: il codice dei server negli ambienti", () => {
  it("serverCode su ogni repository e sull'ambiente", async () => {
    const { projectId: pid, repositoryId } = await seedRepositoryRaw(testDb.db);
    const [srv] = await testDb.db.insert(servers).values({ name: "web", keyHash: `h-${randomBytes(4).toString("hex")}` }).returning();
    const created = await app.inject({ method: "POST", url: `/api/projects/${pid}/environments`, headers: { cookie: adminCookie }, payload: { name: "prod", kind: "production", serverId: srv!.id } });
    expect(created.statusCode, created.body).toBe(201);
    const list = (await app.inject({ method: "GET", url: `/api/projects/${pid}/environments`, headers: { cookie: adminCookie } })).json() as {
      serverCode?: string | null;
      servers: { repositoryId: string; serverCode?: string }[];
    }[];
    expect(list[0]!.serverCode).toBe(`SRV-${srv!.number}`);
    expect(list[0]!.servers).toEqual([expect.objectContaining({ repositoryId, serverCode: `SRV-${srv!.number}` })]);
  });
});

describe("area 8, F4b, S12: i container di un ambiente su un server (l'attribuzione)", () => {
  async function serverWith(services: string[]) {
    const [srv] = await testDb.db.insert(servers).values({ name: `ops-${crypto.randomUUID().slice(0, 6)}`, keyHash: `hash-${crypto.randomUUID()}` }).returning();
    await testDb.db.insert(serverMetrics).values({
      serverId: srv!.id,
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
      services: services.map((name) => ({ source: "docker", name, state: "running", cpuPct: 0, memBytes: 0, restarts: null })) as never,
    });
    return srv!.id;
  }
  const put = (pid: string, envId: string, payload: object, cookie = adminCookie) =>
    app.inject({ method: "PUT", url: `/api/projects/${pid}/environments/${envId}/containers`, headers: { cookie }, payload });
  const envOf = async (pid: string, name: string, serverId: string) =>
    (await app.inject({ method: "POST", url: `/api/projects/${pid}/environments`, headers: { cookie: adminCookie }, payload: { name, kind: "staging", serverId } })).json().id as string;
  const listed = async (pid: string, envId: string) =>
    (await app.inject({ method: "GET", url: `/api/projects/${pid}/environments`, headers: { cookie: adminCookie } })).json().find((e: { id: string }) => e.id === envId)
      .servers as { serverId: string; containers?: string[] }[];

  it("si scrivono (solo nomi che l'agente riporta) e si rileggono per ogni repository; un PATCH che ripete il server li tiene", async () => {
    const srv = await serverWith(["web-a", "db-a"]);
    const { projectId: pid } = await seedRepository(testDb.db);
    const env = await envOf(pid, "staging", srv);
    const ok = await put(pid, env, { serverId: srv, containers: ["web-a", "db-a"] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ serverId: srv, containers: ["web-a", "db-a"] });
    expect((await listed(pid, env)).map((s) => s.containers)).toEqual([["web-a", "db-a"]]);
    // Un mai visto → 422, niente cambia; un nome che non è un nome → 400.
    expect((await put(pid, env, { serverId: srv, containers: ["ghost"] })).statusCode).toBe(422);
    expect((await put(pid, env, { serverId: srv, containers: ["../etc"] })).statusCode).toBe(400);
    expect((await listed(pid, env))[0]!.containers).toEqual(["web-a", "db-a"]);
    // Il PATCH che ripete lo stesso server non li cancella.
    expect((await app.inject({ method: "PATCH", url: `/api/projects/${pid}/environments/${env}`, headers: { cookie: adminCookie }, payload: { serverId: srv } })).statusCode).toBe(200);
    expect((await listed(pid, env))[0]!.containers).toEqual(["web-a", "db-a"]);
  });

  it("lo stesso container in un ALTRO progetto → 409; in un altro ambiente dello STESSO progetto si può", async () => {
    const srv = await serverWith(["web-a", "web-b", "shared"]);
    const { projectId: a } = await seedRepository(testDb.db);
    const { projectId: b } = await seedRepository(testDb.db);
    const envA = await envOf(a, "staging", srv);
    const envA2 = await envOf(a, "production-ish", srv);
    const envB = await envOf(b, "staging", srv);
    expect((await put(a, envA, { serverId: srv, containers: ["web-a", "shared"] })).statusCode).toBe(200);
    expect((await put(a, envA2, { serverId: srv, containers: ["shared"] })).statusCode).toBe(200);
    const clash = await put(b, envB, { serverId: srv, containers: ["web-b", "shared"] });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ code: "container_of_other_project" });
    expect((await listed(b, envB))[0]!.containers).toEqual([]);
    expect((await put(b, envB, { serverId: srv, containers: ["web-b"] })).statusCode).toBe(200);
  });

  it("review F4b, I7: anche il possesso IMPLICITO conta (ambiente di un altro progetto a lista vuota, col nome del container) → 409", async () => {
    const srv = await serverWith(["acme-web", "staging"]);
    const { projectId: a } = await seedRepository(testDb.db);
    const { projectId: b } = await seedRepository(testDb.db);
    await envOf(a, "staging", srv); // A: lista vuota, quindi `staging` è suo per nome.
    const envB = await envOf(b, "prod-b", srv);
    const res = await put(b, envB, { serverId: srv, containers: ["staging"] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "container_of_other_project" });
    expect((await put(b, envB, { serverId: srv, containers: ["acme-web"] })).statusCode).toBe(200);
  });

  it("un server che l'ambiente non usa → 422; senza environments.manage → 403; ambiente di un altro progetto → 404", async () => {
    const srv = await serverWith(["web"]);
    const other = await serverWith(["web"]);
    const { projectId: pid } = await seedRepository(testDb.db);
    const env = await envOf(pid, "staging", srv);
    expect((await put(pid, env, { serverId: other, containers: ["web"] })).statusCode).toBe(422);
    expect((await put(pid, env, { serverId: srv, containers: ["web"] }, memberCookie)).statusCode).toBe(403);
    expect((await put(projectId, env, { serverId: srv, containers: ["web"] })).statusCode).toBe(404);
    expect((await testDb.db.select().from(environmentServers).where(eq(environmentServers.environmentId, env)))[0]!.containers).toEqual([]);
  });
});
