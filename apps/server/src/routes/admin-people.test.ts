import { randomUUID } from "node:crypto";
import { invites, roles, tickets, userTotp, users, type Db } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { PersonDetail, PersonRow } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F1 (aggiunta per R7): le letture calcolate di People. Il test
 * d'ACCORDO: dove la vista dice «si può» (`null`) la scrittura vera riesce,
 * dove dice un motivo la scrittura lo rifiuta.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 5).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function person(prefix = "p") {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@acme.com`;
  const [u] = await db.insert(users).values({ email, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return { id: u!.id, email, cookie: await fullSessionCookie(app, u!.id) };
}
async function instanceRole(permissions: string[]) {
  const [r] = await db.insert(roles).values({ name: `R ${randomUUID().slice(0, 6)}`, scope: "instance", permissions }).returning({ id: roles.id });
  return r!.id;
}
async function manager() {
  const m = await person("mgr");
  await db.update(users).set({ instanceRoleId: await instanceRole(["users.manage", "users.view_all", "users.invite"]) }).where(eq(users.id, m.id));
  return m;
}
const detail = async (cookie: string, id: string) => {
  const res = await app.inject({ method: "GET", url: `/api/admin/people/${id}`, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as PersonDetail };
};

describe("People: le azioni d'accordo con le scritture", () => {
  it("chi gestisce le persone vede `null` dove la scrittura riesce; il secondo fattore assente è `no_second_factor` (e il reset dà 409)", async () => {
    // Una persona SENZA sessione: `fullSessionCookie` le configurerebbe un'app.
    const [bare] = await db.insert(users).values({ email: `bare-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
    const target = { id: bare!.id };
    const { body } = await detail(adminCookie, target.id);
    expect(body.actions).toMatchObject({ resetPassword: null, changeEmail: null, deactivate: null, reactivate: "status", identities: null, resetSecondFactor: "no_second_factor" });
    expect(body.hasSecondFactor).toBe(false);
    const noFactor = await app.inject({ method: "DELETE", url: `/api/users/${target.id}/second-factor`, headers: { cookie: adminCookie } });
    expect(noFactor.statusCode).toBe(409);
    expect(noFactor.json()).toMatchObject({ code: "no_second_factor" });
    expect((await app.inject({ method: "POST", url: `/api/users/${target.id}/password-reset`, headers: { cookie: adminCookie } })).statusCode).toBe(201);
    await db.insert(userTotp).values({ userId: target.id, secretEncrypted: "x", confirmedAt: new Date() });
    expect((await detail(adminCookie, target.id)).body.actions.resetSecondFactor).toBeNull();
    expect((await app.inject({ method: "DELETE", url: `/api/users/${target.id}/second-factor`, headers: { cookie: adminCookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: `/api/users/${target.id}/deactivate`, headers: { cookie: adminCookie }, payload: {} })).statusCode).toBe(204);
    expect((await detail(adminCookie, target.id)).body.actions).toMatchObject({ deactivate: "status", reactivate: null, resetPassword: "status" });
  });

  it("su sé stessi `self`; senza users.manage `forbidden` — e la scrittura dà 400/403", async () => {
    const self = await detail(adminCookie, adminId);
    expect(self.body.isSelf).toBe(true);
    expect(self.body.actions).toMatchObject({ setInstanceRole: "self", deactivate: "self", resetPassword: "self" });
    expect((await app.inject({ method: "POST", url: `/api/users/${adminId}/deactivate`, headers: { cookie: adminCookie }, payload: {} })).statusCode).toBe(400);
    const { projectId } = await seedRepository(db);
    const plain = await person();
    const target = await person();
    await addMember(app, projectId, plain.id, "developer");
    await addMember(app, projectId, target.id, "developer");
    const seen = await detail(plain.cookie, target.id);
    expect(seen.status).toBe(200);
    expect(Object.values(seen.body.actions).every((a) => a === "forbidden")).toBe(true);
    expect(seen.body.instanceRoleChoices).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/api/users/${target.id}/deactivate`, headers: { cookie: plain.cookie }, payload: {} })).statusCode).toBe(403);
  });

  it("l'ultimo full admin: `last_full_admin`, e la disattivazione dà 409", async () => {
    const m = await manager();
    const { body } = await detail(m.cookie, adminId);
    expect(body.isFullAdmin).toBe(true);
    expect(body.actions.deactivate).toBe("last_full_admin");
    expect((await app.inject({ method: "POST", url: `/api/users/${adminId}/deactivate`, headers: { cookie: m.cookie }, payload: {} })).statusCode).toBe(409);
  });

  it("l'ultimo gestore attivo di un progetto: `last_members_manager`, e la disattivazione dà 409", async () => {
    const { projectId } = await seedRepository(db);
    const lead = await person("lead");
    await addMember(app, projectId, lead.id, "project_lead");
    expect((await detail(adminCookie, lead.id)).body.actions.deactivate).toBe("last_members_manager");
    expect((await app.inject({ method: "POST", url: `/api/users/${lead.id}/deactivate`, headers: { cookie: adminCookie }, payload: {} })).statusCode).toBe(409);
  });

  it("instanceRoleChoices: `missing` vuoto ⇒ il cambio riesce; pieno ⇒ 403 escalation", async () => {
    const m = await manager();
    const target = await person();
    const choices = (await detail(m.cookie, target.id)).body.instanceRoleChoices;
    const admin = choices.find((c) => c.name === "Admin")!;
    expect(admin.missing).toContain("instance.full_admin");
    const small = await instanceRole(["users.view_all"]);
    const smallChoice = (await detail(m.cookie, target.id)).body.instanceRoleChoices.find((c) => c.roleId === small)!;
    expect(smallChoice.missing).toEqual([]);
    const patch = (roleId: string) => app.inject({ method: "PATCH", url: `/api/users/${target.id}/instance-role`, headers: { cookie: m.cookie }, payload: { roleId } });
    expect((await patch(small)).statusCode).toBe(200);
    expect((await patch(admin.roleId)).statusCode).toBe(403);
  });

  it("le task aperte coi destinatari ammessi (attivi, che vedono il progetto, mai Claude né lei)", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const target = await person();
    const colleague = await person();
    const gone = await person();
    const outsider = await person();
    for (const u of [target, colleague, gone]) await addMember(app, projectId, u.id, "developer");
    await addMember(app, projectId, (await person()).id, "project_lead");
    await db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, gone.id));
    const { ticketId } = await seedTicket(db, { projectId, repositoryId, number: 9101 });
    await db.update(tickets).set({ assigneeId: target.id }).where(eq(tickets.id, ticketId));
    const { body } = await detail(adminCookie, target.id);
    const task = body.openTasks.find((t) => t.taskId === ticketId)!;
    expect(task.reassignTo).toContain(colleague.id);
    expect(task.reassignTo).toContain(adminId);
    for (const no of [target.id, gone.id, outsider.id]) expect(task.reassignTo).not.toContain(no);
    const [claude] = await db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    expect(task.reassignTo).not.toContain(claude!.id);
    // D'accordo con la scrittura: un destinatario della lista passa, uno fuori no.
    const bad = await app.inject({ method: "POST", url: `/api/users/${target.id}/deactivate`, headers: { cookie: adminCookie }, payload: { reassign: { [ticketId]: outsider.id } } });
    expect(bad.statusCode).toBe(422);
    const ok = await app.inject({ method: "POST", url: `/api/users/${target.id}/deactivate`, headers: { cookie: adminCookie }, payload: { reassign: { [ticketId]: colleague.id } } });
    expect(ok.statusCode).toBe(204);
  });
});

describe("People: l'elenco e la visibilità", () => {
  it("le persone visibili coi progetti visibili; gli inviti col loro id OPACO (mai il token) solo a chi invita; persona invisibile → 404", async () => {
    const { projectId } = await seedRepository(db);
    const { projectId: hidden } = await seedRepository(db);
    const viewer = await person("viewer");
    const mate = await person("mate");
    const stranger = await person("stranger");
    await addMember(app, projectId, viewer.id, "developer");
    await addMember(app, projectId, mate.id, "developer");
    await addMember(app, hidden, mate.id, "developer");
    await addMember(app, hidden, stranger.id, "developer");
    const token = `tok-${randomUUID()}`;
    await db.insert(invites).values({ token, email: `inv-${randomUUID().slice(0, 6)}@acme.com`, expiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: adminId });
    const rows = (await app.inject({ method: "GET", url: "/api/admin/people", headers: { cookie: viewer.cookie } })).json() as PersonRow[];
    expect(rows.map((r) => r.personId)).toContain(mate.id);
    expect(rows.map((r) => r.personId)).not.toContain(stranger.id);
    expect(rows.find((r) => r.personId === mate.id)!.projects).toHaveLength(1);
    expect(rows.some((r) => r.status === "invited")).toBe(false);
    expect((await detail(viewer.cookie, stranger.id)).status).toBe(404);
    expect((await detail(viewer.cookie, mate.id)).body.alsoInHiddenProjects).toBe(true);
    const asAdmin = await app.inject({ method: "GET", url: "/api/admin/people", headers: { cookie: adminCookie } });
    expect(asAdmin.body).not.toContain(token);
    const invited = (asAdmin.json() as PersonRow[]).find((r) => r.status === "invited" && r.invite)!;
    expect(invited.invite!.id).toMatch(/^i_[0-9a-f]{32}$/);
  });
});
