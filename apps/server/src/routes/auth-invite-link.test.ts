import { randomUUID } from "node:crypto";
import { inviteProjects, invites, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";
import { inviteIdOf } from "../services/admin-people.js";
import { hashInviteToken } from "../services/invite-token.js";

/**
 * Area 9, F1 (decisione del maintainer): la lettura pubblica dell'invito e
 * `register` con l'email dell'invito. Dettagli SOLO su un invito valido.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminId: string;
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 6).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

let ip = 0;
const fromNewIp = () => `10.8.${Math.floor(++ip / 250)}.${ip % 250}`;
const read = (token: string) => app.inject({ method: "GET", url: `/api/auth/invites/${token}`, remoteAddress: fromNewIp() });
const register = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/auth/register", payload, remoteAddress: fromNewIp() });
const EMPTY = { email: null, invitedByName: null, projects: [], instanceRoleName: null, expiresAt: null };

async function invite(opts: { expired?: boolean; instanceRole?: boolean; project?: boolean } = {}) {
  const token = `inv-${randomUUID()}`;
  const email = `new-${randomUUID().slice(0, 6)}@acme.com`;
  let instanceRoleId: string | undefined;
  if (opts.instanceRole) {
    const [r] = await db.insert(roles).values({ name: `Ufficio ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["monitor.view"] }).returning({ id: roles.id });
    instanceRoleId = r!.id;
  }
  // Nel DB l'hash (R3), nel link il token in chiaro: come lo scrive il server.
  await db.insert(invites).values({ token: hashInviteToken(token), email, expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 86_400_000)), invitedByUserId: adminId, ...(instanceRoleId ? { instanceRoleId } : {}) });
  if (opts.project) {
    const { projectId } = await seedRepository(db);
    const [dev] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
    await db.insert(inviteProjects).values({ inviteToken: hashInviteToken(token), projectId, roleId: dev!.id });
  }
  return { token, email };
}

describe("R3: il token dell'invito si conserva come hash", () => {
  it("l'invito creato salva l'hash: il link in chiaro si apre e registra, l'hash del DB no", async () => {
    const email = `hash-${randomUUID().slice(0, 6)}@acme.com`;
    const created = await app.inject({ method: "POST", url: "/api/auth/invites", headers: { cookie: adminCookie }, payload: { email } });
    expect(created.statusCode, created.body).toBe(201);
    const { token, id } = created.json() as { token: string; id: string };
    const [row] = await db.select({ token: invites.token }).from(invites).where(eq(invites.email, email));
    // Nel DB c'è l'hash, mai il token del link; e l'id opaco viene dall'hash.
    expect(row!.token).toBe(hashInviteToken(token));
    expect(row!.token).not.toBe(token);
    expect(id).toBe(inviteIdOf(row!.token));
    // Chi ha solo il DB non apre l'invito: l'hash usato come token è sbagliato.
    expect((await read(row!.token)).json()).toMatchObject({ status: "invalid" });
    // Il link sì, e registra.
    expect((await read(token)).json()).toMatchObject({ status: "valid", email });
    const res = await register({ token, password: "password-lunga-1" });
    expect(res.statusCode, res.body).toBe(201);
    expect(await db.select().from(invites).where(eq(invites.email, email))).toHaveLength(0);
  });

  it("la revoca col token del link toglie l'invito", async () => {
    const email = `rev-${randomUUID().slice(0, 6)}@acme.com`;
    const { token } = (await app.inject({ method: "POST", url: "/api/auth/invites", headers: { cookie: adminCookie }, payload: { email } })).json() as { token: string };
    const del = await app.inject({ method: "DELETE", url: `/api/auth/invites/${token}`, headers: { cookie: adminCookie } });
    expect(del.statusCode, del.body).toBe(204);
    expect(await db.select().from(invites).where(eq(invites.email, email))).toHaveLength(0);
  });
});

describe("la lettura pubblica dell'invito", () => {
  it("valido: email, chi invita, progetti col ruolo, ruolo d'istanza (se non User), scadenza; e non cambia niente", async () => {
    const i = await invite({ instanceRole: true, project: true });
    const res = await read(i.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: "valid", email: i.email, invitedByName: "admin", instanceRoleName: expect.stringMatching(/^Ufficio/) });
    expect(body.projects).toEqual([expect.objectContaining({ roleName: "Developer", name: expect.any(String) })]);
    expect(body.expiresAt).not.toBeNull();
    expect(await db.select().from(invites).where(eq(invites.token, hashInviteToken(i.token)))).toHaveLength(1);
    const plain = await invite();
    expect((await read(plain.token)).json()).toMatchObject({ status: "valid", instanceRoleName: null, projects: [] });
  });

  it("NEGATIVI: scaduto → solo lo stato; sbagliato, usato e revocato → lo stesso `invalid`, senza nomi né date", async () => {
    const expired = await invite({ expired: true, project: true });
    expect((await read(expired.token)).json()).toEqual({ status: "expired", ...EMPTY });
    const bodies = new Set<string>();
    bodies.add((await read("token-inventato")).body);
    const used = await invite();
    expect((await register({ token: used.token, password: "una-password-lunga-123" })).statusCode).toBe(201);
    bodies.add((await read(used.token)).body);
    const revoked = await invite();
    await db.delete(invites).where(eq(invites.token, hashInviteToken(revoked.token)));
    bodies.add((await read(revoked.token)).body);
    expect([...bodies]).toEqual([JSON.stringify({ status: "invalid", ...EMPTY })]);
  });
});

describe("register con l'email dell'invito", () => {
  it("senza email vale quella dell'invito; con la stessa (maiuscole a parte) va; con un'altra 400 e l'invito resta", async () => {
    const a = await invite();
    expect((await register({ token: a.token, password: "una-password-lunga-123" })).statusCode).toBe(201);
    expect(await db.select().from(users).where(eq(users.email, a.email))).toHaveLength(1);
    const b = await invite();
    expect((await register({ token: b.token, email: b.email.toUpperCase(), password: "una-password-lunga-123" })).statusCode).toBe(201);
    const c = await invite();
    const wrong = await register({ token: c.token, email: "altro@acme.com", password: "una-password-lunga-123" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: "invite_email_mismatch" });
    expect(await db.select().from(users).where(eq(users.email, "altro@acme.com"))).toHaveLength(0);
    expect(await db.select().from(invites).where(eq(invites.token, hashInviteToken(c.token)))).toHaveLength(1);
  });
});

describe("il nome nel corpo di register e setup (review di F1, C1) e l'id dell'invito (I2)", () => {
  it("register con `displayName`: lo scrive sulla persona NUOVA, e il cookie di un'altra nel browser non la tocca", async () => {
    const [adminBefore] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, adminId));
    const { fullSessionCookie } = await import("../test/fixtures.js");
    const adminSession = await fullSessionCookie(app, adminId);
    const i = await invite();
    const res = await app.inject({ method: "POST", url: "/api/auth/register", headers: { cookie: adminSession }, payload: { token: i.token, password: "una-password-lunga-123", displayName: "Bea Nuova" }, remoteAddress: fromNewIp() });
    expect(res.statusCode).toBe(201);
    const [created] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.email, i.email));
    expect(created!.displayName).toBe("Bea Nuova");
    const [adminAfter] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, adminId));
    expect(adminAfter!.displayName).toBe(adminBefore!.displayName);
    // Le regole di PATCH /api/auth/me: niente a capo.
    const j = await invite();
    expect((await register({ token: j.token, password: "una-password-lunga-123", displayName: "Bea\nX" })).statusCode).toBe(400);
  });

  it("setup con `displayName`, su un'istanza vergine", async () => {
    const fresh = await startTestDb();
    const freshApp = buildApp({ db: fresh.db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 6).toString("base64") });
    try {
      const res = await freshApp.inject({ method: "POST", url: "/api/auth/setup", payload: { email: "first@acme.com", password: "una-password-lunga-123", displayName: "Ada Prima" }, remoteAddress: fromNewIp() });
      expect(res.statusCode).toBe(201);
      const [u] = await fresh.db.select({ displayName: users.displayName }).from(users).where(eq(users.email, "first@acme.com"));
      expect(u!.displayName).toBe("Ada Prima");
    } finally {
      await freshApp.close();
      await fresh.stop();
    }
  }, 120_000);

  it("la creazione dell'invito restituisce l'id OPACO del server", async () => {
    const { fullSessionCookie } = await import("../test/fixtures.js");
    const cookie = await fullSessionCookie(app, adminId);
    const res = await app.inject({ method: "POST", url: "/api/auth/invites", headers: { cookie }, payload: { email: `id-${randomUUID().slice(0, 6)}@acme.com` } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; token: string };
    expect(body.id).toBe(inviteIdOf(hashInviteToken(body.token)));
    expect(body.id).toMatch(/^i_[0-9a-f]{32}$/);
  });
});
