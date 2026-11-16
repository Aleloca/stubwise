import { randomUUID } from "node:crypto";
import { inviteProjects, invites, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F1 (decisione del maintainer): la lettura pubblica dell'invito e
 * `register` con l'email dell'invito. Dettagli SOLO su un invito valido.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 6).toString("base64") });
  await seedUsers(app);
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
  await db.insert(invites).values({ token, email, expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 86_400_000)), invitedByUserId: adminId, ...(instanceRoleId ? { instanceRoleId } : {}) });
  if (opts.project) {
    const { projectId } = await seedRepository(db);
    const [dev] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
    await db.insert(inviteProjects).values({ inviteToken: token, projectId, roleId: dev!.id });
  }
  return { token, email };
}

describe("la lettura pubblica dell'invito", () => {
  it("valido: email, chi invita, progetti col ruolo, ruolo d'istanza (se non User), scadenza; e non cambia niente", async () => {
    const i = await invite({ instanceRole: true, project: true });
    const res = await read(i.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: "valid", email: i.email, invitedByName: "admin", instanceRoleName: expect.stringMatching(/^Ufficio/) });
    expect(body.projects).toEqual([expect.objectContaining({ roleName: "Developer", name: expect.any(String) })]);
    expect(body.expiresAt).not.toBeNull();
    expect(await db.select().from(invites).where(eq(invites.token, i.token))).toHaveLength(1);
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
    await db.delete(invites).where(eq(invites.token, revoked.token));
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
    expect(await db.select().from(invites).where(eq(invites.token, c.token))).toHaveLength(1);
  });
});
