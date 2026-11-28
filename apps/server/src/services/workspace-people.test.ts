import { randomUUID } from "node:crypto";
import { projects, tickets, users, workspaceMembers, workspaceProjects, workspaces, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { actorAs, addMember, createUserWithSession, presetRoleId, seedUsers } from "../test/fixtures.js";
import { managedProjectIds } from "./admin-people.js";
import { suggestRecipients } from "./mail-recipients.js";
import { peopleKnownTo } from "./people-known.js";
import { deactivateUser } from "./user-deactivation.js";

/**
 * Workspace, lotto 2, gruppo 2 (`docs/plans/2026-11-27-workspace-piano.md`):
 * persone e destinatari. Wanda è nella workspace «Clienti» (che contiene
 * Farmacia), Nino è membro ESPLICITO di Farmacia, Olga non c'entra.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: SESSION_SECRET, encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  ({ adminId } = await seedUsers(app));
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const userOf = (id: string) => ({ id, instancePermissions: new Set<never>() });

async function seed(presetKey = "viewer") {
  const [p] = await db.insert(projects).values({ name: "Farmacia", slug: `far-${randomUUID().slice(0, 6)}`, ingestionKey: randomUUID() }).returning();
  const wanda = await createUserWithSession(app, `wanda-${randomUUID()}@x.test`);
  const nino = await createUserWithSession(app, `nino-${randomUUID()}@x.test`);
  const olga = await createUserWithSession(app, `olga-${randomUUID()}@x.test`);
  await db.update(users).set({ displayName: "Wanda Rossi" }).where(eq(users.id, wanda.id));
  await addMember(app, p!.id, nino.id, "developer");
  const [w] = await db.insert(workspaces).values({ name: "Clienti", colorToken: "--dept-1" }).returning();
  await db.insert(workspaceProjects).values({ workspaceId: w!.id, projectId: p!.id });
  await db.insert(workspaceMembers).values({ workspaceId: w!.id, userId: wanda.id, roleId: await presetRoleId(app, presetKey) });
  return { projectId: p!.id, wanda, nino, olga, workspaceId: w!.id };
}

describe("chi si conosce e chi si vede", () => {
  it("peopleKnownTo: Nino conosce Wanda (stesso progetto, per workspace), Olga no", async () => {
    const { wanda, nino, olga } = await seed();
    expect(await peopleKnownTo(db, userOf(nino.id), [wanda.id])).toContain(wanda.id);
    expect(await peopleKnownTo(db, userOf(wanda.id), [nino.id])).toContain(nino.id);
    expect(await peopleKnownTo(db, userOf(olga.id), [wanda.id])).not.toContain(wanda.id);
  });

  it("D5: due persone di una workspace SENZA progetti si conoscono; chi è fuori no", async () => {
    const a = await createUserWithSession(app, `a-${randomUUID()}@x.test`);
    const b = await createUserWithSession(app, `b-${randomUUID()}@x.test`);
    const c = await createUserWithSession(app, `c-${randomUUID()}@x.test`);
    const [w] = await db.insert(workspaces).values({ name: "Vuota", colorToken: "--dept-2" }).returning();
    const viewer = await presetRoleId(app, "viewer");
    await db.insert(workspaceMembers).values([
      { workspaceId: w!.id, userId: a.id, roleId: viewer },
      { workspaceId: w!.id, userId: b.id, roleId: viewer },
    ]);
    expect(await peopleKnownTo(db, userOf(a.id), [b.id])).toContain(b.id);
    expect(await peopleKnownTo(db, userOf(c.id), [b.id])).not.toContain(b.id);
  });

  it("GET /api/users: Nino vede Wanda, Olga no (senza users.view_all)", async () => {
    const { wanda, nino, olga } = await seed();
    const { roles } = await import("@stubwise/db");
    const [narrow] = await db.insert(roles).values({ name: `Stretto ${randomUUID().slice(0, 6)}`, scope: "instance", permissions: [] }).returning();
    for (const id of [nino.id, olga.id]) await db.update(users).set({ instanceRoleId: narrow!.id }).where(eq(users.id, id));
    const ids = async (headers: { cookie: string }) => ((await app.inject({ method: "GET", url: "/api/users", headers })).json() as { id: string }[]).map((u) => u.id);
    expect(await ids(nino.headers)).toContain(wanda.id);
    expect(await ids(olga.headers)).not.toContain(wanda.id);
  });

  it("suggestRecipients: Nino trova Wanda per nome, Olga no", async () => {
    const { wanda, nino, olga } = await seed();
    const [{ email }] = (await db.select({ email: users.email }).from(users).where(eq(users.id, wanda.id))) as [{ email: string }];
    expect((await suggestRecipients(db, userOf(nino.id), "Wanda")).map((r) => r.email)).toContain(email);
    expect(await suggestRecipients(db, userOf(olga.id), "Wanda")).toEqual([]);
  });

  it("i membri di un progetto (GET /api/projects/:id, memberIds) comprendono Wanda", async () => {
    const { projectId, wanda, nino } = await seed();
    const body = (await app.inject({ method: "GET", url: `/api/projects/${projectId}`, headers: nino.headers })).json() as { memberIds: string[] };
    expect(body.memberIds).toContain(wanda.id);
  });
});

describe("chi gestisce e chi riceve", () => {
  it("managedProjectIds: il Project Lead di workspace gestisce i membri del progetto, il Viewer di workspace no", async () => {
    const lead = await seed("project_lead");
    const viewer = await seed("viewer");
    expect(await managedProjectIds(db, userOf(lead.wanda.id), [lead.projectId])).toEqual(new Set([lead.projectId]));
    expect(await managedProjectIds(db, userOf(viewer.wanda.id), [viewer.projectId])).toEqual(new Set());
  });

  it("disattivando Nino, una sua task si può riassegnare a Wanda (vede il progetto per workspace), non a Olga", async () => {
    const { projectId, wanda, nino, olga } = await seed();
    const task = async () =>
      (await db.insert(tickets).values({ projectId, number: Math.floor(Math.random() * 1e6), title: "Etichette", type: "bug", priority: "medium", source: "manual", assigneeId: nino.id }).returning())[0]!.id;
    const admin = { ...actorAs(adminId, "admin"), email: "admin@example.com" };
    const toOlga = await task();
    await expect(deactivateUser(db, admin, nino.id, { [toOlga]: olga.id })).rejects.toMatchObject({ code: "invalid_reassignment" });
    await db.update(tickets).set({ assigneeId: null }).where(eq(tickets.id, toOlga));
    const toWanda = await task();
    await deactivateUser(db, admin, nino.id, { [toWanda]: wanda.id });
    const [row] = await db.select({ assigneeId: tickets.assigneeId }).from(tickets).where(eq(tickets.id, toWanda));
    expect(row!.assigneeId).toBe(wanda.id);
  });
});
