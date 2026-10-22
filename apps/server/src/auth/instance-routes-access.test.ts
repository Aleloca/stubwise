import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { aiProviders, invites, projectMembers, projects, roles, serverProjects, servers, users } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * Le rotte d'istanza dichiarano il permesso in `config.access` (task 4 del
 * piano dei permessi). Qui, con ruoli veri: l'utente `User` (preset, ogni
 * `member` dei fixture) è respinto sulle scritture SENZA che lo stato cambi,
 * continua a leggere ciò che leggeva, e i server di monitoraggio si vedono
 * anche per un progetto collegato quando manca `monitor.view`.
 */

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let memberId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
    publicUrl: "https://stubwise.example.com",
    monitorRateLimit: { max: 10_000, timeWindow: "1 minute" },
  });
  ({ adminCookie, memberCookie, memberId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("utente User: scritture d'istanza respinte, stato invariato", () => {
  it("POST /api/servers → 403 e nessun server creato", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/servers",
      headers: { cookie: memberCookie },
      payload: { name: "negato" },
    });
    expect(res.statusCode).toBe(403);
    expect(await testDb.db.select().from(servers)).toHaveLength(0);
  });

  it("POST /api/auth/invites → 403 e nessun invito creato", async () => {
    const before = (await testDb.db.select().from(invites)).length;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/invites",
      headers: { cookie: memberCookie },
      payload: { email: "nuovo@example.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(await testDb.db.select().from(invites)).toHaveLength(before);
  });

  it("PATCH /api/users/:id/role → 403 e ruolo invariato", async () => {
    const [admin] = await testDb.db.select().from(users).where(eq(users.email, "admin@example.com"));
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${admin!.id}/role`,
      headers: { cookie: memberCookie },
      payload: { role: "member" },
    });
    expect(res.statusCode).toBe(403);
    const [after] = await testDb.db.select().from(users).where(eq(users.id, admin!.id));
    expect(after!.role).toBe("admin");
  });

  it("PUT /api/settings/instance → 403", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/instance",
      headers: { cookie: memberCookie },
      payload: { contentLanguage: "it" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /api/ai-providers → 403 e nessun account creato", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ai-providers",
      headers: { cookie: memberCookie },
      payload: { kind: "api_key", label: "x", secret: "sk-ant-test" },
    });
    expect(res.statusCode).toBe(403);
    expect(await testDb.db.select().from(aiProviders)).toHaveLength(0);
  });

  it.each([
    ["GET", "/api/ai-providers"],
    ["GET", "/api/plugins"],
    ["GET", "/api/settings/instance"],
    ["GET", "/api/settings/models"],
    ["GET", "/api/ai-usage/costs"],
    ["GET", "/api/ai-usage/snapshots"],
    ["GET", "/api/auth/invites"],
    ["POST", "/api/activity/generate"],
  ] as const)("%s %s → 403", async (method, url) => {
    const res = await app.inject({ method, url, headers: { cookie: memberCookie }, payload: method === "POST" ? { date: "2026-01-01" } : undefined });
    expect(res.statusCode).toBe(403);
  });
});

describe("utente User: ciò che leggeva resta leggibile", () => {
  it.each([
    "/api/git-accounts",
    "/api/settings/mail-admission",
    "/api/servers",
    "/api/users",
    "/api/auth/me",
  ])("GET %s → 200", async (url) => {
    const res = await app.inject({ method: "GET", url, headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(200);
  });

  it("senza sessione → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/servers" });
    expect(res.statusCode).toBe(401);
  });
});

describe("permessi granulari d'istanza", () => {
  it("un ruolo con solo users.invite invita ma non gestisce gli utenti", async () => {
    const [role] = await testDb.db
      .insert(roles)
      .values({ name: "Solo inviti", scope: "instance", permissions: ["users.invite"] })
      .returning();
    const login = await app.inject({ method: "POST", url: "/api/auth/invites", headers: { cookie: adminCookie }, payload: { email: "inv@example.com" } });
    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { token: (login.json() as { token: string }).token, email: "inv@example.com", password: "password-inv" },
    });
    const invUserId = (register.json() as { user: { id: string } }).user.id;
    await testDb.db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, invUserId));
    const loginRes = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "inv@example.com", password: "password-inv" } });
    const cookie = `stubwise_session=${loginRes.cookies.find((c) => c.name === "stubwise_session")!.value}`;

    const ok = await app.inject({ method: "GET", url: "/api/auth/invites", headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: `/api/users/${memberId}/password-reset`,
      headers: { cookie },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe("server di monitoraggio: visibilità tramite progetto collegato", () => {
  it("senza monitor.view: vede il server di un suo progetto, non quello altrui", async () => {
    const [mine] = await testDb.db.insert(servers).values({ name: "mio", keyHash: "h1" }).returning();
    const [other] = await testDb.db.insert(servers).values({ name: "altrui", keyHash: "h2" }).returning();
    const [pMine] = await testDb.db.insert(projects).values({ name: "Mio", slug: "mio-mon", ingestionKey: "ik-mio" }).returning();
    const [pOther] = await testDb.db.insert(projects).values({ name: "Altrui", slug: "altrui-mon", ingestionKey: "ik-altrui" }).returning();
    await testDb.db.insert(serverProjects).values([
      { serverId: mine!.id, projectId: pMine!.id },
      { serverId: other!.id, projectId: pOther!.id },
    ]);
    const [projectRole] = await testDb.db.select().from(roles).where(eq(roles.scope, "project")).limit(1);
    await testDb.db.insert(projectMembers).values({ projectId: pMine!.id, userId: memberId, roleId: projectRole!.id });

    // Con il preset User (monitor.view) li vede entrambi.
    const withView = await app.inject({ method: "GET", url: "/api/servers", headers: { cookie: memberCookie } });
    const namesWith = (withView.json() as { name: string }[]).map((s) => s.name);
    expect(namesWith).toContain("mio");
    expect(namesWith).toContain("altrui");

    // Si toglie monitor.view: resta solo il server del progetto di cui è membro.
    const [noMonitor] = await testDb.db
      .insert(roles)
      .values({ name: "Senza monitor", scope: "instance", permissions: ["users.view_all"] })
      .returning();
    await testDb.db.update(users).set({ instanceRoleId: noMonitor!.id }).where(eq(users.id, memberId));

    const list = await app.inject({ method: "GET", url: "/api/servers", headers: { cookie: memberCookie } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { name: string }[]).map((s) => s.name)).toEqual(["mio"]);

    const detailMine = await app.inject({ method: "GET", url: `/api/servers/${mine!.id}`, headers: { cookie: memberCookie } });
    expect(detailMine.statusCode).toBe(200);
    const detailOther = await app.inject({ method: "GET", url: `/api/servers/${other!.id}`, headers: { cookie: memberCookie } });
    expect(detailOther.statusCode).toBe(404);
    const checksOther = await app.inject({ method: "GET", url: `/api/servers/${other!.id}/checks`, headers: { cookie: memberCookie } });
    expect(checksOther.statusCode).toBe(404);
    const checksMine = await app.inject({ method: "GET", url: `/api/servers/${mine!.id}/checks`, headers: { cookie: memberCookie } });
    expect(checksMine.statusCode).toBe(200);
    const metricsOther = await app.inject({
      method: "GET",
      url: `/api/servers/${other!.id}/metrics?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z`,
      headers: { cookie: memberCookie },
    });
    expect(metricsOther.statusCode).toBe(404);
  });
});
