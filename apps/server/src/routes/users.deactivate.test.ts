import { randomUUID } from "node:crypto";
import { deviceTokens, emailChanges, invites, personalAccessTokens, roles, securityEvents, sessions, tickets, users, type Db } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { instancePermissionsOfUser, projectPermissionsOfUser } from "@stubwise/notifications";
import { resolveReporter } from "../ingest/reporter.js";
import { hashPassword } from "../auth/password.js";
import { generatePat, hashServerKey } from "./shared.js";
import { addMember, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F1, Task 4: disattivare e riattivare una persona (D-6;
 * docs/invariants/permissions.md, «Una persona disattivata non entra da
 * nessuna porta, e non si disattiva l'ultimo full admin»).
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 4).toString("base64") });
  ({ adminCookie, adminId } = await seedUsers(app));
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const PASSWORD = "password-della-persona";
let n = 0;
async function person() {
  const email = `p-${++n}-${randomUUID().slice(0, 6)}@acme.com`;
  const [u] = await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD), role: "member" }).returning({ id: users.id });
  const cookie = await fullSessionCookie(app, u!.id);
  const token = generatePat();
  const [pat] = await db.insert(personalAccessTokens).values({ userId: u!.id, name: "pat", tokenHash: hashServerKey(token) }).returning({ id: personalAccessTokens.id });
  await db.insert(deviceTokens).values({ userId: u!.id, patId: pat!.id, platform: "ios", token: `dev-${randomUUID()}` });
  return { id: u!.id, email, cookie, token };
}
const admin = () => ({ cookie: adminCookie });
const deactivate = (id: string, body: Record<string, unknown> = {}, as: { cookie: string } = admin()) =>
  app.inject({ method: "POST", url: `/api/users/${id}/deactivate`, headers: { cookie: as.cookie }, payload: body });
const reactivate = (id: string) => app.inject({ method: "POST", url: `/api/users/${id}/reactivate`, headers: { cookie: adminCookie } });
const login = (email: string, password = PASSWORD) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
const me = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/api/auth/me", headers });

describe("disattivare una persona", () => {
  it("dopo: il login risponde COME una password sbagliata, la sessione e il PAT sono 401, i device spenti; nel registro di sicurezza", async () => {
    const p = await person();
    const wrong = await login(p.email, "sbagliata");
    expect((await me({ cookie: p.cookie })).statusCode).toBe(200);
    expect((await deactivate(p.id)).statusCode).toBe(204);
    const after = await login(p.email);
    expect(after.statusCode).toBe(wrong.statusCode);
    expect(after.body).toBe(wrong.body);
    expect((await me({ cookie: p.cookie })).statusCode).toBe(401);
    expect((await me({ authorization: `Bearer ${p.token}` })).statusCode).toBe(401);
    expect(await db.select().from(sessions).where(eq(sessions.userId, p.id))).toEqual([]);
    expect(await db.select().from(personalAccessTokens).where(eq(personalAccessTokens.userId, p.id))).toEqual([]);
    // I device si SPENGONO (non si cancellano: la traccia del perché resta), come alla revoca di un PAT.
    const devices = await db.select().from(deviceTokens).where(eq(deviceTokens.userId, p.id));
    expect(devices.length).toBeGreaterThan(0);
    expect(devices.every((d) => d.disabledAt !== null && d.disabledReason === "user_deactivated")).toBe(true);
    const [event] = await db.select().from(securityEvents).where(and(eq(securityEvents.userId, p.id), eq(securityEvents.kind, "deactivated")));
    expect(event).toBeDefined();
    const list = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: adminCookie } })).json() as { id: string; status?: string }[];
    expect(list.find((u) => u.id === p.id)?.status).toBe("deactivated");
    const people = (await app.inject({ method: "GET", url: "/api/people", headers: { cookie: adminCookie } })).json() as { id: string; deactivated: boolean }[];
    expect(people.find((x) => x.id === p.id)?.deactivated).toBe(true);
  });

  it("una sessione o un PAT sopravvissuti a una corsa (re-inseriti DOPO) non entrano: il controllo è anche a lettura", async () => {
    const p = await person();
    await deactivate(p.id);
    const cookie = await fullSessionCookie(app, p.id);
    expect((await me({ cookie })).statusCode).toBe(401);
    const token = generatePat();
    await db.insert(personalAccessTokens).values({ userId: p.id, name: "dopo", tokenHash: hashServerKey(token) });
    expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
  });

  it("le task aperte si riassegnano PER TASK; quelle senza riga restano sue; gli inviti che ha mandato si revocano", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const { projectId: other, repositoryId: otherRepo } = await seedRepository(db);
    const p = await person();
    const a = await person();
    const b = await person();
    await addMember(app, projectId, a.id, "developer");
    await addMember(app, other, b.id, "developer");
    const t1 = (await seedTicket(db, { projectId, repositoryId, number: 7001 })).ticketId;
    const t2 = (await seedTicket(db, { projectId: other, repositoryId: otherRepo, number: 7002 })).ticketId;
    const t3 = (await seedTicket(db, { projectId, repositoryId, number: 7003 })).ticketId;
    for (const t of [t1, t2, t3]) await db.update(tickets).set({ assigneeId: p.id }).where(eq(tickets.id, t));
    await db.insert(invites).values({ token: `inv-${randomUUID()}`, email: `x-${randomUUID()}@acme.com`, expiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: p.id });
    const res = await deactivate(p.id, { reassign: { [t1]: a.id, [t2]: b.id } });
    expect(res.statusCode).toBe(204);
    const assignee = async (id: string) => (await db.select({ a: tickets.assigneeId }).from(tickets).where(eq(tickets.id, id)))[0]!.a;
    expect(await assignee(t1)).toBe(a.id);
    expect(await assignee(t2)).toBe(b.id);
    expect(await assignee(t3)).toBe(p.id);
    expect(await db.select().from(invites).where(eq(invites.invitedByUserId, p.id))).toEqual([]);
  });

  it("NEGATIVI della riassegnazione: un destinatario che non vede il progetto della SUA task, una task non sua → 422 e NIENTE cambiato", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const p = await person();
    const outsider = await person();
    const t1 = (await seedTicket(db, { projectId, repositoryId, number: 7101 })).ticketId;
    const notHis = (await seedTicket(db, { projectId, repositoryId, number: 7102 })).ticketId;
    await db.update(tickets).set({ assigneeId: p.id }).where(eq(tickets.id, t1));
    const bad = await deactivate(p.id, { reassign: { [t1]: outsider.id } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ code: "invalid_reassignment", taskId: t1 });
    const notOwn = await deactivate(p.id, { reassign: { [notHis]: adminId } });
    expect(notOwn.statusCode).toBe(422);
    expect(notOwn.json()).toMatchObject({ code: "invalid_reassignment", taskId: notHis });
    // Niente cambiato: è ancora attiva, con la sua sessione.
    expect((await me({ cookie: p.cookie })).statusCode).toBe(200);
    expect((await db.select({ a: tickets.assigneeId }).from(tickets).where(eq(tickets.id, t1)))[0]!.a).toBe(p.id);
  });

  it("NEGATIVI: sé stessi (400), Claude (404), senza users.manage (403), l'ultimo full admin ATTIVO (409)", async () => {
    expect((await deactivate(adminId)).json()).toMatchObject({ code: "cannot_deactivate_self" });
    // Claude c'è già (un solo utente di sistema, `users_single_agent`).
    const [agent] = await db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    expect((await deactivate(agent!.id)).statusCode).toBe(404);
    const plain = await person();
    expect((await deactivate(plain.id, {}, { cookie: plain.cookie })).statusCode).toBe(403);
    // Un gestore delle persone (non full admin) e un secondo full admin.
    const lone = await person();
    const [mgrRole] = await db.insert(roles).values({ name: `Gestore ${randomUUID()}`, scope: "instance", permissions: ["users.manage", "users.view_all"] }).returning({ id: roles.id });
    await db.update(users).set({ instanceRoleId: mgrRole!.id }).where(eq(users.id, lone.id));
    const loneCookie = await fullSessionCookie(app, lone.id);
    const second = await person();
    const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "admin"));
    await db.update(users).set({ instanceRoleId: adminRole!.id }).where(eq(users.id, second.id));
    expect((await deactivate(second.id, {}, { cookie: loneCookie })).statusCode).toBe(204);
    // Ora l'unico full admin ATTIVO è il primo: un disattivato non conta.
    const last = await deactivate(adminId, {}, { cookie: loneCookie });
    expect(last.statusCode).toBe(409);
    expect(last.json()).toMatchObject({ code: "last_full_admin" });
    expect((await me({ cookie: adminCookie })).statusCode).toBe(200);
  });

  it("riattivare la riporta, senza le sessioni né i token di prima", async () => {
    const p = await person();
    await deactivate(p.id);
    expect((await reactivate(p.id)).statusCode).toBe(204);
    expect((await login(p.email)).statusCode).not.toBe(401);
    expect((await me({ authorization: `Bearer ${p.token}` })).statusCode).toBe(401);
    expect((await me({ cookie: p.cookie })).statusCode).toBe(401);
    const [event] = await db.select().from(securityEvents).where(and(eq(securityEvents.userId, p.id), eq(securityEvents.kind, "reactivated")));
    expect(event).toBeDefined();
  });
});

describe("le porte LATERALI di una persona disattivata (review di F1, I1)", () => {
  it("l'attribuzione dei ticket esterni e i permessi per conto di un id: tutto come se non ci fosse", async () => {
    const { projectId } = await seedRepository(db);
    const p = await person();
    await addMember(app, projectId, p.id, "project_lead");
    // Un secondo gestore attivo: sennò l'ultimo gestore non si disattiva (m4).
    await addMember(app, projectId, (await person()).id, "project_lead");
    // Prima: c'è.
    expect((await projectPermissionsOfUser(db, p.id, projectId))?.has("plans.approve")).toBe(true);
    expect((await deactivate(p.id)).statusCode).toBe(204);
    // Dopo: da nessuna di queste strade.
    expect(await resolveReporter(db, p.email)).toBeNull();
    expect(await projectPermissionsOfUser(db, p.id, projectId)).toBeNull();
    expect((await instancePermissionsOfUser(db, p.id)).size).toBe(0);
  });
});

describe("la disattivazione annulla il cambio dell'email in attesa (review di F1, m5)", () => {
  it("dopo disattivazione e riattivazione il vecchio link non vale più", async () => {
    const p = await person();
    await db.insert(emailChanges).values({ userId: p.id, newEmail: `n-${randomUUID().slice(0, 6)}@acme.com`, tokenHash: "h".repeat(64), expiresAt: new Date(Date.now() + 3_600_000) });
    expect((await deactivate(p.id)).statusCode).toBe(204);
    expect((await reactivate(p.id)).statusCode).toBe(204);
    const pending = await db.select().from(emailChanges).where(and(eq(emailChanges.userId, p.id), isNull(emailChanges.cancelledAt)));
    expect(pending).toHaveLength(0);
  });
});

describe("gli altri bordi della disattivazione (review di F1, m4, m6, m9)", () => {
  it("m4: disattivare l'ultimo gestore ATTIVO di un progetto → 409 last_manager col projectId, niente cambiato; un gestore disattivato non conta", async () => {
    const { projectId } = await seedRepository(db);
    const lead = await person();
    await addMember(app, projectId, lead.id, "project_lead");
    const res = await deactivate(lead.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "last_manager", projectId });
    expect((await db.select({ d: users.deactivatedAt }).from(users).where(eq(users.id, lead.id)))[0]!.d).toBeNull();
    // Con un secondo gestore attivo si disattiva; poi il secondo è l'ultimo ATTIVO.
    const second = await person();
    await addMember(app, projectId, second.id, "project_lead");
    expect((await deactivate(lead.id)).statusCode).toBe(204);
    const again = await deactivate(second.id);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "last_manager", projectId });
  });

  it("m6: niente link di reset per una persona disattivata (404)", async () => {
    const p = await person();
    expect((await deactivate(p.id)).statusCode).toBe(204);
    const res = await app.inject({ method: "POST", url: `/api/users/${p.id}/password-reset`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(404);
  });

  it("m9: una persona disattivata non entra in un progetto né riceve una task (422 user_deactivated)", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const p = await person();
    expect((await deactivate(p.id)).statusCode).toBe(204);
    const [dev] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
    const put = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${p.id}`, headers: { cookie: adminCookie }, payload: { roleId: dev!.id } });
    expect(put.statusCode).toBe(422);
    expect(put.json()).toMatchObject({ code: "user_deactivated" });
    const { ticketId } = await seedTicket(db, { projectId, repositoryId, number: 7301 });
    const viaTask = await app.inject({ method: "PATCH", url: `/api/tasks/${ticketId}`, headers: { cookie: adminCookie }, payload: { assigneeId: p.id } });
    expect(viaTask.statusCode).toBe(422);
    expect(viaTask.json()).toMatchObject({ code: "user_deactivated" });
    const viaTicket = await app.inject({ method: "PATCH", url: `/api/tickets/${ticketId}`, headers: { cookie: adminCookie }, payload: { assigneeId: p.id } });
    expect(viaTicket.statusCode).toBe(422);
    expect((await db.select({ a: tickets.assigneeId }).from(tickets).where(eq(tickets.id, ticketId)))[0]!.a).toBeNull();
  });
});
