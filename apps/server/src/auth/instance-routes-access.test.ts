import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  aiModelSettings,
  aiProviders,
  gitAccounts,
  gitIdentities,
  googleWorkspaces,
  instanceSettings,
  invites,
  plugins,
  projectMembers,
  projects,
  roles,
  serverProjects,
  servers,
  serviceChecks,
  users,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { fullSessionCookie, seedUsers } from "../test/fixtures.js";

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

/** Crea un utente (invito + registrazione) con un ruolo d'istanza opzionale e ne restituisce id e cookie. */
async function makeUser(email: string, instanceRoleId?: string): Promise<{ id: string; cookie: string }> {
  const invite = await app.inject({ method: "POST", url: "/api/auth/invites", headers: { cookie: adminCookie }, payload: { email } });
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { token: (invite.json() as { token: string }).token, email, password: "password-test-1" },
  });
  const id = (register.json() as { user: { id: string } }).user.id;
  if (instanceRoleId) await testDb.db.update(users).set({ instanceRoleId }).where(eq(users.id, id));
  return { id, cookie: await fullSessionCookie(app, id) };
}

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
    const [row] = await testDb.db.select().from(instanceSettings);
    expect(row?.contentLanguage ?? "en").toBe("en");
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

describe("utente User: altre scritture d'istanza respinte, stato invariato", () => {
  it("git-accounts: POST/PATCH/DELETE/PUT default-reviewer → 403, nessuna riga cambia", async () => {
    const [acc] = await testDb.db
      .insert(gitAccounts)
      .values({ name: "Originale", provider: "github", encryptedCredentials: "x" })
      .returning();
    const created = await app.inject({
      method: "POST",
      url: "/api/git-accounts",
      headers: { cookie: memberCookie },
      payload: { name: "Nuovo", provider: "github", credentials: { username: "u", token: "t" } },
    });
    expect(created.statusCode).toBe(403);
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/git-accounts/${acc!.id}`,
      headers: { cookie: memberCookie },
      payload: { name: "Rinominato" },
    });
    expect(patched.statusCode).toBe(403);
    const deleted = await app.inject({ method: "DELETE", url: `/api/git-accounts/${acc!.id}`, headers: { cookie: memberCookie } });
    expect(deleted.statusCode).toBe(403);
    const validate = await app.inject({ method: "POST", url: `/api/git-accounts/${acc!.id}/validate`, headers: { cookie: memberCookie } });
    expect(validate.statusCode).toBe(403);
    const rows = await testDb.db.select().from(gitAccounts);
    expect(rows.map((r) => r.name)).toEqual(["Originale"]);
  });

  it("google-workspaces: POST → 403, nessun workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/google-workspaces",
      headers: { cookie: memberCookie },
      payload: { name: "Acme", domains: ["acme.com"], clientId: "1.apps.googleusercontent.com", clientSecret: "segreto" },
    });
    expect(res.statusCode).toBe(403);
    expect(await testDb.db.select().from(googleWorkspaces)).toHaveLength(0);
  });

  it("git-identity: git-identities, bitbucket, observed-authors → 403, nessuna identità", async () => {
    const post = await app.inject({
      method: "POST",
      url: `/api/users/${memberId}/git-identities`,
      headers: { cookie: memberCookie },
      payload: { email: "x@example.com" },
    });
    expect(post.statusCode).toBe(403);
    const put = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/bitbucket`,
      headers: { cookie: memberCookie },
      payload: { username: "mallory" },
    });
    expect(put.statusCode).toBe(403);
    const get = await app.inject({ method: "GET", url: "/api/git/observed-authors", headers: { cookie: memberCookie } });
    expect(get.statusCode).toBe(403);
    expect(await testDb.db.select().from(gitIdentities)).toHaveLength(0);
    const [u] = await testDb.db.select().from(users).where(eq(users.id, memberId));
    expect(u!.bitbucketUsername).toBeNull();
  });

  it("slack identity: PUT users/:id/slack e GET workspace-users → 403, utente non linkato", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `/api/users/${memberId}/slack`,
      headers: { cookie: memberCookie },
      payload: { slackUserId: "U123" },
    });
    expect(put.statusCode).toBe(403);
    const get = await app.inject({ method: "GET", url: "/api/slack/workspace-users", headers: { cookie: memberCookie } });
    expect(get.statusCode).toBe(403);
    const [u] = await testDb.db.select().from(users).where(eq(users.id, memberId));
    expect(u!.slackUserId).toBeNull();
  });

  it("servers-checks: POST/PUT/DELETE check → 403, nessun check", async () => {
    const [srv] = await testDb.db.insert(servers).values({ name: "per-check", keyHash: "hc" }).returning();
    const post = await app.inject({
      method: "POST",
      url: `/api/servers/${srv!.id}/checks`,
      headers: { cookie: memberCookie },
      payload: { type: "http", name: "h", target: "https://api.example.com/health", intervalSeconds: 30, enabled: true },
    });
    expect(post.statusCode).toBe(403);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/servers/${srv!.id}/checks/00000000-0000-4000-8000-000000000000`,
      headers: { cookie: memberCookie },
    });
    expect(del.statusCode).toBe(403);
    expect(await testDb.db.select().from(serviceChecks)).toHaveLength(0);
  });

  it("model-settings: PATCH → 403, nessuna impostazione", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings/models",
      headers: { cookie: memberCookie },
      payload: { models: { fix_execute: "claude-opus-5-5" } },
    });
    expect(res.statusCode).toBe(403);
    expect(await testDb.db.select().from(aiModelSettings)).toHaveLength(0);
  });

  it("plugins: POST → 403, nessun plugin registrato", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/plugins",
      headers: { cookie: memberCookie },
      payload: { sourceUrl: "https://github.com/obra/superpowers", ref: "v1" },
    });
    expect(res.statusCode).toBe(403);
    expect(await testDb.db.select().from(plugins)).toHaveLength(0);
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
    const cookie = await fullSessionCookie(app, invUserId);

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
    const monUser = await makeUser("mon@example.com");
    const monCookie = monUser.cookie;
    await testDb.db.insert(projectMembers).values({ projectId: pMine!.id, userId: monUser.id, roleId: projectRole!.id });

    // Con il preset User (monitor.view) li vede entrambi.
    const withView = await app.inject({ method: "GET", url: "/api/servers", headers: { cookie: monCookie } });
    const namesWith = (withView.json() as { name: string }[]).map((s) => s.name);
    expect(namesWith).toContain("mio");
    expect(namesWith).toContain("altrui");

    // Si toglie monitor.view: resta solo il server del progetto di cui è membro.
    const [noMonitor] = await testDb.db
      .insert(roles)
      .values({ name: "Senza monitor", scope: "instance", permissions: ["users.view_all"] })
      .returning();
    await testDb.db.update(users).set({ instanceRoleId: noMonitor!.id }).where(eq(users.id, monUser.id));

    const list = await app.inject({ method: "GET", url: "/api/servers", headers: { cookie: monCookie } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { name: string }[]).map((s) => s.name)).toEqual(["mio"]);

    const detailMine = await app.inject({ method: "GET", url: `/api/servers/${mine!.id}`, headers: { cookie: monCookie } });
    expect(detailMine.statusCode).toBe(200);
    const detailOther = await app.inject({ method: "GET", url: `/api/servers/${other!.id}`, headers: { cookie: monCookie } });
    expect(detailOther.statusCode).toBe(404);
    const checksOther = await app.inject({ method: "GET", url: `/api/servers/${other!.id}/checks`, headers: { cookie: monCookie } });
    expect(checksOther.statusCode).toBe(404);
    const checksMine = await app.inject({ method: "GET", url: `/api/servers/${mine!.id}/checks`, headers: { cookie: monCookie } });
    expect(checksMine.statusCode).toBe(200);
    const metricsOther = await app.inject({
      method: "GET",
      url: `/api/servers/${other!.id}/metrics?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z`,
      headers: { cookie: monCookie },
    });
    expect(metricsOther.statusCode).toBe(404);
  });
});
