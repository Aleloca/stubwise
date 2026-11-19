import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createFakeEmbeddingClient } from "@stubwise/embeddings";
import { automations, projects, repositories, tickets, users, widgets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { projectPermissionsOfUser } from "@stubwise/notifications";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithPat, seedUsers } from "../test/fixtures.js";
import { inProjects, projectIdsWithPermission, projectPermissionsFor, visibleProjectIds } from "./access.js";

/**
 * Area 9, F6 (D-8, L-1 = a): un progetto archiviato è come uno che non c'è,
 * in UN posto. Le primitive di visibilità lo escludono (un progetto: `null`;
 * gli elenchi: il full admin riceve `{ all: true, archived }`, mai più un
 * `"all"` che non filtra); una scrittura di chi lo vedrebbe è 409
 * `archived`, quella di un estraneo 404; una lettura non dichiarata è 404.
 */
let testDb: TestDb;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: randomBytes(32).toString("base64"),
    publicUrl: "https://stubwise.example.com",
    embeddingClient: createFakeEmbeddingClient(),
  });
  ({ adminCookie, adminId } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/** Due progetti, uno aperto e uno archiviato, con lo stesso Project Lead. */
async function twoProjects() {
  const open = await seedRepository(testDb.db);
  const archived = await seedRepository(testDb.db);
  const lead = await createUserWithPat(app, `${randomUUID()}@acme.com`);
  await addMember(app, open.projectId, lead.id, "project_lead");
  await addMember(app, archived.projectId, lead.id, "project_lead");
  await testDb.db.update(projects).set({ archivedAt: new Date(), archivedByUserId: adminId }).where(eq(projects.id, archived.projectId));
  return { open: open.projectId, archived: archived.projectId, lead };
}

async function adminUser() {
  const [u] = await testDb.db.select().from(users).where(eq(users.id, adminId));
  return { id: u!.id, instancePermissions: new Set(["instance.full_admin"]) as never };
}

describe("area 9, F6: le primitive escludono l'archiviato", () => {
  it("un progetto: null per il membro E per il full admin; aperto: i permessi", async () => {
    const { open, archived, lead } = await twoProjects();
    const leadUser = { id: lead.id, instancePermissions: new Set() as never };
    expect(await projectPermissionsFor(testDb.db, leadUser, archived)).toBeNull();
    expect(await projectPermissionsFor(testDb.db, await adminUser(), archived)).toBeNull();
    expect(await projectPermissionsFor(testDb.db, leadUser, open)).not.toBeNull();
    expect(await projectPermissionsOfUser(testDb.db, lead.id, archived)).toBeNull();
    expect(await projectPermissionsOfUser(testDb.db, adminId, archived)).toBeNull();
    expect(await projectPermissionsOfUser(testDb.db, lead.id, open)).not.toBeNull();
  });

  it("gli elenchi: il membro non lo riceve; il full admin riceve { all, archived } e inProjects lo esclude nella WHERE", async () => {
    const { open, archived, lead } = await twoProjects();
    const leadUser = { id: lead.id, instancePermissions: new Set() as never };
    const mine = await visibleProjectIds(testDb.db, leadUser);
    expect(mine).toContain(open);
    expect(mine).not.toContain(archived);
    expect(await projectIdsWithPermission(testDb.db, leadUser, "tickets.view_all")).not.toContain(archived);
    const all = await visibleProjectIds(testDb.db, await adminUser());
    expect(all).toMatchObject({ all: true });
    expect((all as unknown as { archived: string[] }).archived).toContain(archived);
    const rows = await testDb.db.select({ id: projects.id }).from(projects).where(inProjects(projects.id, all));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(open);
    expect(ids).not.toContain(archived);
  });

  it("GET /api/projects e /api/auth/me non lo nominano, per il membro e per il full admin", async () => {
    const { open, archived, lead } = await twoProjects();
    for (const headers of [lead.headers, { cookie: adminCookie }]) {
      const list = await app.inject({ method: "GET", url: "/api/projects", headers });
      const ids = (list.json() as { id: string }[]).map((p) => p.id);
      expect(ids).toContain(open);
      expect(ids).not.toContain(archived);
      const me = await app.inject({ method: "GET", url: "/api/auth/me", headers });
      const perms = (me.json() as { projectPermissions: Record<string, string[]> }).projectPermissions;
      expect(perms[open]).toBeDefined();
      expect(perms[archived]).toBeUndefined();
    }
  });

  it("NEGATIVI: lettura non dichiarata 404; scrittura 409 `archived` per chi lo vedrebbe, 404 per un estraneo; niente cambia", async () => {
    const { archived, lead } = await twoProjects();
    const stranger = await createUserWithPat(app, `${randomUUID()}@acme.com`);
    for (const headers of [lead.headers, { cookie: adminCookie }]) {
      expect((await app.inject({ method: "GET", url: `/api/projects/${archived}`, headers })).statusCode).toBe(404);
      const patch = await app.inject({ method: "PATCH", url: `/api/projects/${archived}`, headers, payload: { name: "Cambiato" } });
      expect(patch.statusCode).toBe(409);
      expect((patch.json() as { code: string }).code).toBe("archived");
    }
    const patch = await app.inject({ method: "PATCH", url: `/api/projects/${archived}`, headers: stranger.headers, payload: { name: "Cambiato" } });
    expect(patch.statusCode).toBe(404);
    const [row] = await testDb.db.select({ name: projects.name }).from(projects).where(eq(projects.id, archived));
    expect(row!.name).toBe("Progetto di test");
  });

  it("le superfici: ricerca, task, automazioni, Stato dell'istanza, «Chi può farlo?» — per il membro e per il full admin", async () => {
    const { open, archived, lead } = await twoProjects();
    const word = `archsrf${randomUUID().slice(0, 8)}`;
    await testDb.db.update(projects).set({ name: `${word} chiuso` }).where(eq(projects.id, archived));
    await testDb.db.update(projects).set({ name: `${word} aperto` }).where(eq(projects.id, open));
    const n = Math.floor(Math.random() * 1_000_000);
    await testDb.db.insert(tickets).values([
      { projectId: archived, number: 1, title: `${word} task chiusa`, type: "bug", priority: "medium", status: "triaged", source: "manual" },
      { projectId: open, number: 1, title: `${word} task aperta`, type: "bug", priority: "medium", status: "triaged", source: "manual" },
    ]);
    await testDb.db.insert(automations).values([
      { code: `AR${n}-A1`, seq: n, name: `${word} auto chiusa`, projectId: archived, ownerId: adminId, status: "active", activeSince: new Date() },
      { code: `AR${n}-A2`, seq: n + 1, name: `${word} auto aperta`, projectId: open, ownerId: adminId, status: "active", activeSince: new Date() },
    ]);
    for (const headers of [lead.headers, { cookie: adminCookie }]) {
      const search = await app.inject({ method: "GET", url: `/api/search?q=${word}`, headers });
      expect(search.statusCode).toBe(200);
      const body = search.json() as { projects: { items: { id: string }[] }; tickets: { items: { projectId: string }[] }; automations: { items: { name: string }[] } };
      expect(body.projects.items.map((p) => p.id)).toEqual([open]);
      expect(body.tickets.items.map((t) => t.projectId)).toEqual([open]);
      expect(JSON.stringify(body.automations)).not.toContain("auto chiusa");
      const list = await app.inject({ method: "GET", url: `/api/tickets?q=${word}`, headers });
      expect(JSON.stringify(list.json())).toContain("task aperta");
      expect(JSON.stringify(list.json())).not.toContain("task chiusa");
      const autos = await app.inject({ method: "GET", url: "/api/automations", headers });
      expect(JSON.stringify(autos.json())).toContain("auto aperta");
      expect(JSON.stringify(autos.json())).not.toContain("auto chiusa");
      const who = await app.inject({ method: "GET", url: `/api/access/who-can?permission=tickets.edit&projectId=${archived}`, headers });
      expect(who.statusCode).toBe(404);
    }
    // Lo Stato dell'istanza elenca le code che hanno qualcosa da dire: tutte e due in pausa.
    await testDb.db.update(projects).set({ queuePausedAt: new Date() }).where(eq(projects.id, open));
    await testDb.db.update(projects).set({ queuePausedAt: new Date() }).where(eq(projects.id, archived));
    const status = await app.inject({ method: "GET", url: "/api/instance/status", headers: { cookie: adminCookie } });
    expect(status.statusCode).toBe(200);
    expect(JSON.stringify(status.json())).toContain(open);
    expect(JSON.stringify(status.json())).not.toContain(archived);
  });

  it("le superfici PUBBLICHE trattano un archiviato come uno slug sconosciuto (401), un aperto no: SDK, ingresso, widget, webhook git", async () => {
    const { open, archived } = await twoProjects();
    const setup = async (projectId: string) => {
      const [p] = await testDb.db.select().from(projects).where(eq(projects.id, projectId));
      const [w] = await testDb.db.insert(widgets).values({ projectId, name: "W", key: `wk-${randomUUID()}` }).returning();
      const [r] = await testDb.db.select().from(repositories).where(eq(repositories.projectId, projectId));
      await testDb.db.update(repositories).set({ webhookSecret: "segreto" }).where(eq(repositories.id, r!.id));
      return { slug: p!.slug, key: p!.ingestionKey!, widgetKey: w!.key, repoSlug: r!.slug };
    };
    const body = JSON.stringify({ ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), commits: [] });
    const calls = async (x: Awaited<ReturnType<typeof setup>>) => [
      (await app.inject({ method: "POST", url: `/ingest/${x.slug}`, headers: { "x-stubwise-key": x.key }, payload: {} })).statusCode,
      (await app.inject({ method: "POST", url: `/api/inbound/${x.slug}/ticket`, headers: { "x-stubwise-key": x.key }, payload: {} })).statusCode,
      (await app.inject({ method: "GET", url: `/widget/${x.slug}/config`, headers: { "x-stubwise-key": x.widgetKey } })).statusCode,
      (
        await app.inject({
          method: "POST",
          url: `/webhooks/git/${x.repoSlug}`,
          headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${createHmac("sha256", "segreto").update(body).digest("hex")}` },
          payload: body,
        })
      ).statusCode,
    ];
    const openCodes = await calls(await setup(open));
    const archivedCodes = await calls(await setup(archived));
    expect(archivedCodes).toEqual([401, 401, 401, 401]);
    for (const code of openCodes) expect(code).not.toBe(401);
  });
});
