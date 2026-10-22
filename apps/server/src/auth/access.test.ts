import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentSessions,
  aiJobs,
  backlogItems,
  docPages,
  milestones,
  personalAccessTokens,
  projectMembers,
  repositories,
  roles,
  tickets,
  users,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { PROJECT_PERMISSIONS } from "@stubwise/shared";
import { buildApp } from "../app.js";
import { generatePat, hashServerKey } from "../routes/shared.js";
import { seedUsers } from "../test/fixtures.js";
import { projectPermissionsFor, visibleProjectIds, type RouteAccess } from "./access.js";
import {
  fromAgentSession,
  fromBacklogItem,
  fromDocPage,
  fromJob,
  fromMilestone,
  fromParam,
  fromRepository,
  fromTicket,
} from "./project-resolvers.js";
import { findPatUser, type SessionUser } from "./session.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

/** Quante volte gli handler delle rotte che devono fallire chiuse sono stati eseguiti. */
const handlerRuns = { throws: 0, unknownKind: 0, undeclared: 0 };

let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let memberCookie: string;
let projectId: string;
let ticketId: string;
/** PAT per utente: autenticazione delle richieste e SessionUser via findPatUser. */
const pats: Record<"admin" | "developer" | "lead" | "outsider", string> = {
  admin: "",
  developer: "",
  lead: "",
  outsider: "",
};

async function presetRoleId(presetKey: string): Promise<string> {
  const [row] = await testDb.db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.presetKey, presetKey));
  if (!row) throw new Error(`preset ${presetKey} assente`);
  return row.id;
}

async function patFor(userId: string): Promise<string> {
  const token = generatePat();
  await testDb.db
    .insert(personalAccessTokens)
    .values({ userId, name: "t", tokenHash: hashServerKey(token) });
  return token;
}

/** Utente `member` (ruolo d'istanza User, dal trigger) creato direttamente nel DB. */
async function createUser(email: string): Promise<string> {
  const [row] = await testDb.db
    .insert(users)
    .values({ email, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  return row!.id;
}

async function sessionUserOf(who: keyof typeof pats): Promise<SessionUser> {
  const user = await findPatUser(testDb.db, `Bearer ${pats[who]}`);
  if (!user) throw new Error(`PAT di ${who} non risolto`);
  return user;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
    publicUrl: "https://stubwise.example.com",
  });
  // Rotte di prova, solo su questa istanza: dichiarano l'accesso come le
  // rotte vere, e l'hook globale di app.ts lo applica.
  app.get(
    "/test-access/tickets/:ticketId/approve",
    {
      config: {
        access: { kind: "project", permission: "plans.approve", project: fromTicket("ticketId") },
      },
    },
    async (request) => ({ projectId: request.access?.projectId }),
  );
  app.get(
    "/test-access/projects/:projectId/member",
    { config: { access: { kind: "project", permission: "member", project: fromParam("projectId") } } },
    async (request) => ({ projectId: request.access?.projectId }),
  );
  app.get(
    "/test-access/throws/:ticketId",
    {
      config: {
        access: {
          kind: "project",
          permission: "member",
          project: async () => {
            throw new Error("resolver rotto");
          },
        },
      },
    },
    async () => {
      handlerRuns.throws += 1;
      return { ok: true };
    },
  );
  app.get(
    "/test-access/unknown-kind",
    // Una dichiarazione che il tipo non prevede (un cast di troppo): l'hook
    // deve chiudere, non lasciar passare.
    { config: { access: { kind: "bogus" } as unknown as RouteAccess } },
    async () => {
      handlerRuns.unknownKind += 1;
      return { ok: true };
    },
  );
  // Nessuna dichiarazione: l'hook deve chiudere (ruling R48).
  app.get("/test-access/undeclared", async () => {
    handlerRuns.undeclared += 1;
    return { ok: true };
  });
  app.get(
    "/test-access/users-manage",
    { config: { access: { kind: "instance", permission: "users.manage" } } },
    async () => ({ ok: true }),
  );
  app.get("/test-access/public", { config: { access: { kind: "public" } } }, async () => ({
    ok: true,
  }));
  app.get("/test-access/user", { config: { access: { kind: "user" } } }, async (request) => ({
    id: request.user?.id,
  }));

  const seeded = await seedUsers(app);
  adminCookie = seeded.adminCookie;
  memberCookie = seeded.memberCookie;

  ({ projectId } = await seedRepository(testDb.db));
  const [ticket] = await testDb.db
    .insert(tickets)
    .values({ projectId, number: 1, title: "t", type: "bug", priority: "low", source: "manual" })
    .returning({ id: tickets.id });
  ticketId = ticket!.id;

  const leadId = await createUser("lead@example.com");
  const outsiderId = await createUser("outsider@example.com");
  // Il member di seedUsers è il Developer del progetto (cookie e PAT).
  await testDb.db.insert(projectMembers).values([
    { projectId, userId: seeded.memberId, roleId: await presetRoleId("developer") },
    { projectId, userId: leadId, roleId: await presetRoleId("project_lead") },
  ]);
  pats.admin = await patFor(seeded.adminId);
  pats.developer = await patFor(seeded.memberId);
  pats.lead = await patFor(leadId);
  pats.outsider = await patFor(outsiderId);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("permessi risolti dal server", () => {
  it("(a) il full admin vede il progetto senza esserne membro, con ogni permesso", async () => {
    const admin = await sessionUserOf("admin");
    expect(admin.instancePermissions.has("instance.full_admin")).toBe(true);
    const perms = await projectPermissionsFor(testDb.db, admin, projectId);
    expect(perms).not.toBeNull();
    expect([...perms!].sort()).toEqual([...PROJECT_PERMISSIONS].sort());
    expect(await visibleProjectIds(testDb.db, admin)).toBe("all");
  });

  it("(b) un Developer ha runs.start e non plans.approve", async () => {
    const dev = await sessionUserOf("developer");
    const perms = await projectPermissionsFor(testDb.db, dev, projectId);
    expect(perms?.has("runs.start")).toBe(true);
    expect(perms?.has("plans.approve")).toBe(false);
    expect(await visibleProjectIds(testDb.db, dev)).toEqual([projectId]);
  });

  it("(c) un non membro non vede il progetto", async () => {
    const outsider = await sessionUserOf("outsider");
    expect(await projectPermissionsFor(testDb.db, outsider, projectId)).toBeNull();
    expect(await visibleProjectIds(testDb.db, outsider)).toEqual([]);
  });

  it("un progetto inesistente è invisibile anche al full admin", async () => {
    const admin = await sessionUserOf("admin");
    expect(await projectPermissionsFor(testDb.db, admin, randomUUID())).toBeNull();
  });
});

describe("hook globale: config.access", () => {
  const approve = (headers: Record<string, string>, id = ticketId) =>
    app.inject({ method: "GET", url: `/test-access/tickets/${id}/approve`, headers });
  const bearer = (who: keyof typeof pats) => ({ authorization: `Bearer ${pats[who]}` });

  it("(d) project/plans.approve: non membro 404, Developer 403, Project Lead 200", async () => {
    expect((await approve(bearer("outsider"))).statusCode).toBe(404);
    const dev = await approve({ cookie: memberCookie });
    expect(dev.statusCode).toBe(403);
    expect(dev.json()).toMatchObject({ code: "forbidden" });
    const lead = await approve(bearer("lead"));
    expect(lead.statusCode).toBe(200);
    // request.access è impostato dall'hook col progetto risolto.
    expect(lead.json()).toEqual({ projectId });
    expect((await approve({ cookie: adminCookie })).statusCode).toBe(200);
  });

  it("(d) ticket inesistente o id malformato → 404 not_found, anche per il full admin", async () => {
    const missing = await approve({ cookie: adminCookie }, randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "not_found" });
    expect((await approve({ cookie: adminCookie }, "non-un-uuid")).statusCode).toBe(404);
  });

  it("(e) instance/users.manage: User 403, Admin 200", async () => {
    const asUser = await app.inject({
      method: "GET",
      url: "/test-access/users-manage",
      headers: { cookie: memberCookie },
    });
    expect(asUser.statusCode).toBe(403);
    expect(asUser.json()).toMatchObject({ code: "forbidden" });
    const asAdmin = await app.inject({
      method: "GET",
      url: "/test-access/users-manage",
      headers: { cookie: adminCookie },
    });
    expect(asAdmin.statusCode).toBe(200);
  });

  it("(f) un PAT eredita i permessi dell'utente", async () => {
    // Stesso utente (il Developer), cookie e PAT: stesso esito.
    expect((await approve(bearer("developer"))).statusCode).toBe(403);
    const manage = (headers: Record<string, string>) =>
      app.inject({ method: "GET", url: "/test-access/users-manage", headers });
    expect((await manage(bearer("developer"))).statusCode).toBe(403);
    expect((await manage(bearer("admin"))).statusCode).toBe(200);
    const dev = await sessionUserOf("developer");
    expect([...dev.instancePermissions].sort()).toEqual(
      ["git_accounts.view", "mail_admission.view", "monitor.view", "users.view_all"].sort(),
    );
  });

  it("project/member: il membro (qualunque ruolo) e il full admin passano, il non membro 404", async () => {
    const member = (headers: Record<string, string>, id = projectId) =>
      app.inject({ method: "GET", url: `/test-access/projects/${id}/member`, headers });
    expect((await member({ cookie: memberCookie })).statusCode).toBe(200);
    expect((await member(bearer("lead"))).json()).toEqual({ projectId });
    expect((await member({ cookie: adminCookie })).statusCode).toBe(200);
    const outsider = await member(bearer("outsider"));
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json()).toMatchObject({ code: "not_found" });
    expect((await member({ cookie: adminCookie }, randomUUID())).statusCode).toBe(404);
  });

  it("un resolver che lancia → 500, e l'handler non gira", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/test-access/throws/${ticketId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(500);
    expect(handlerRuns.throws).toBe(0);
  });

  it("un kind sconosciuto → 500 esplicito, e l'handler non gira (anche per il full admin)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test-access/unknown-kind",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: "internal_error" });
    expect(handlerRuns.unknownKind).toBe(0);
  });

  it("una rotta senza config.access è chiusa: 500 route_access_undeclared, handler mai eseguito (R48)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test-access/undeclared",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: "route_access_undeclared" });
    expect(handlerRuns.undeclared).toBe(0);
  });

  it("il preflight CORS (OPTIONS) di inbound e ingest passa ancora, e un URL inesistente resta 404", async () => {
    for (const url of ["/api/inbound/demo/ticket", "/ingest/demo"]) {
      const res = await app.inject({
        method: "OPTIONS",
        url,
        headers: {
          origin: "https://customer.example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-stubwise-key",
        },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    }
    const missing = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(missing.statusCode).toBe(404);
  });

  it("senza credenziali: 401 sulle rotte autenticate, 200 su public", async () => {
    expect((await app.inject({ method: "GET", url: "/test-access/user" })).statusCode).toBe(401);
    expect((await approve({})).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/test-access/public" })).statusCode).toBe(200);
    const asUser = await app.inject({
      method: "GET",
      url: "/test-access/user",
      headers: bearer("outsider"),
    });
    expect(asUser.statusCode).toBe(200);
  });
});

describe("resolver del progetto", () => {
  const req = (params: Record<string, string>) => ({ params }) as unknown as FastifyRequest;
  const missing = randomUUID();

  it("ognuno risale al progetto, e dà null per un'entità inesistente o un id malformato", async () => {
    const db = testDb.db;
    const [repo] = await db
      .select({ id: repositories.id, slug: repositories.slug })
      .from(repositories)
      .where(eq(repositories.projectId, projectId));
    const [item] = await db
      .insert(backlogItems)
      .values({ projectId, title: "b", originContent: "o", source: "manual" })
      .returning({ id: backlogItems.id });
    const [milestone] = await db
      .insert(milestones)
      .values({ projectId, name: "m" })
      .returning({ id: milestones.id });
    const [job] = await db.insert(aiJobs).values({ ticketId }).returning({ id: aiJobs.id });
    const [page] = await db
      .insert(docPages)
      .values({ repositoryId: repo!.id, kind: "technical", slug: "p", title: "p" })
      .returning({ id: docPages.id });
    // Sessione senza projectId diretto: il progetto si risale dal job.
    const [session] = await db
      .insert(agentSessions)
      .values({ ownerKey: `k-${randomUUID()}`, kind: "ai_job", title: "s", aiJobId: job!.id })
      .returning({ id: agentSessions.id });

    const cases: [ReturnType<typeof fromParam>, string][] = [
      [fromParam("id"), projectId],
      [fromTicket("id"), ticketId],
      [fromBacklogItem("id"), item!.id],
      [fromRepository("id"), repo!.id],
      [fromRepository("id"), repo!.slug],
      [fromMilestone("id"), milestone!.id],
      [fromJob("id"), job!.id],
      [fromDocPage("id"), page!.id],
      [fromAgentSession("id"), session!.id],
    ];
    for (const [resolver, id] of cases) {
      expect(await resolver(req({ id }), db)).toBe(projectId);
      expect(await resolver(req({ id: missing }), db)).toBeNull();
      expect(await resolver(req({}), db)).toBeNull();
    }
    expect(await fromTicket("id")(req({ id: "non-un-uuid" }), db)).toBeNull();
  });
});
