import { randomUUID } from "node:crypto";
import { projectMemberPermissions, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  INSTANCE_PERMISSIONS,
  PROJECT_PERMISSIONS,
  type WhatCanResponse,
  type WhoCanResponse,
} from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { can } from "../auth/access.js";
import { createSession, findSessionUser } from "../auth/session.js";
import { addMember, fullSessionCookie, seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F1, Task 9 (design 1.7, D-11): «Chi può farlo?» e «Cosa può fare?»,
 * con lo STESSO calcolo di `can()`.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

let projectA: string;
let projectB: string;
const seed: Record<"dev" | "viewerWithGrant" | "manager" | "outsider" | "deactivated", string> = {} as never;

async function person(prefix: string) {
  const [u] = await db.insert(users).values({ email: `${prefix}-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id });
  return u!.id;
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 9).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
  ({ projectId: projectA } = await seedRepository(db));
  ({ projectId: projectB } = await seedRepository(db));
  seed.dev = await person("dev");
  await addMember(app, projectA, seed.dev, "developer");
  seed.viewerWithGrant = await person("viewer");
  await addMember(app, projectA, seed.viewerWithGrant, "viewer");
  await db.insert(projectMemberPermissions).values({ projectId: projectA, userId: seed.viewerWithGrant, permission: "runs.start", grantedByUserId: adminId });
  seed.manager = await person("manager");
  const [managerRole] = await db.insert(roles).values({ name: `Gestore ${randomUUID().slice(0, 4)}`, scope: "instance", permissions: ["users.manage", "users.view_all"] }).returning({ id: roles.id });
  await db.update(users).set({ instanceRoleId: managerRole!.id }).where(eq(users.id, seed.manager));
  seed.outsider = await person("outsider");
  await addMember(app, projectB, seed.outsider, "developer");
  seed.deactivated = await person("gone");
  await addMember(app, projectA, seed.deactivated, "developer");
  await db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, seed.deactivated));
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const whoCan = (cookie: string, permission: string, projectId?: string) =>
  app.inject({ method: "GET", url: `/api/access/who-can?permission=${permission}${projectId ? `&projectId=${projectId}` : ""}`, headers: { cookie } });
const whatCan = (cookie: string, userId: string, projectId?: string) =>
  app.inject({ method: "GET", url: `/api/access/what-can?userId=${userId}${projectId ? `&projectId=${projectId}` : ""}`, headers: { cookie } });

async function sessionUserOf(userId: string) {
  const session = await createSession(db, userId, { stage: "full", secondFactorAt: new Date() });
  return (await findSessionUser(db, session.id))!;
}

describe("«Chi può farlo?»", () => {
  it("ACCORDO: per ogni persona attiva e ogni permesso, who-can ⇔ can() (d'istanza senza progetto, di progetto sul progetto A)", async () => {
    const people = [adminId, seed.dev, seed.viewerWithGrant, seed.manager, seed.outsider];
    const sessionUsers = await Promise.all(people.map(sessionUserOf));
    for (const permission of [...INSTANCE_PERMISSIONS, ...PROJECT_PERMISSIONS]) {
      const instance = (INSTANCE_PERMISSIONS as readonly string[]).includes(permission);
      const res = await whoCan(adminCookie, permission, instance ? undefined : projectA);
      expect(res.statusCode, permission).toBe(200);
      const listed = new Set((res.json() as WhoCanResponse).people.map((p) => p.userId));
      for (const user of sessionUsers) {
        const expected = await can(db, user, permission, instance ? undefined : projectA);
        expect(listed.has(user.id), `${user.email} / ${permission}`).toBe(expected);
      }
      expect(listed.has(seed.deactivated)).toBe(false);
    }
  });

  it("i motivi: full admin, ruolo (con id e nome), personale (con chi l'ha dato)", async () => {
    const body = (await whoCan(adminCookie, "runs.start", projectA)).json() as WhoCanResponse;
    const row = (id: string) => body.people.find((p) => p.userId === id)!;
    expect(row(adminId).reasons.map((r) => r.kind)).toContain("full_admin");
    expect(row(seed.dev).reasons).toEqual([expect.objectContaining({ kind: "role", roleName: "Developer" })]);
    expect(row(seed.viewerWithGrant).reasons).toEqual([expect.objectContaining({ kind: "grant", byUserId: adminId })]);
    const manage = (await whoCan(adminCookie, "users.manage")).json() as WhoCanResponse;
    expect(manage.people.find((p) => p.userId === seed.manager)!.reasons).toEqual([expect.objectContaining({ kind: "role", roleName: expect.stringMatching(/^Gestore/) })]);
  });

  it("Claude: nessuna riga (non ha permessi suoi), e il fatto fisso «agisce per chi conferma»", async () => {
    const [agent] = await db.select({ id: users.id }).from(users).where(eq(users.isAgent, true));
    for (const [permission, projectId] of [["runs.start", projectA], ["tickets.create", projectA], ["users.view_all", undefined]] as const) {
      const body = (await whoCan(adminCookie, permission, projectId)).json() as WhoCanResponse;
      expect(body.people.map((p) => p.userId)).not.toContain(agent!.id);
      expect(body.agent).toEqual({ actsFor: "confirmer" });
    }
  });

  it("NEGATIVI: ambito sbagliato (422), progetto invisibile (404), chi guarda vede solo le persone che vede", async () => {
    expect((await whoCan(adminCookie, "runs.start")).json()).toMatchObject({ code: "wrong_scope" });
    expect((await whoCan(adminCookie, "users.manage", projectA)).statusCode).toBe(422);
    const devCookie = await fullSessionCookie(app, seed.dev);
    expect((await whoCan(devCookie, "runs.start", projectB)).statusCode).toBe(404);
    // Un permesso d'istanza che l'outsider HA davvero (lo dice l'admin, che lo vede).
    const outsiderPerm = ((await whatCan(adminCookie, seed.outsider)).json() as WhatCanResponse).instance[0]!.permission;
    const byAdmin = (await whoCan(adminCookie, outsiderPerm)).json() as WhoCanResponse;
    expect(byAdmin.people.map((p) => p.userId)).toContain(seed.outsider);
    const instanceList = (await whoCan(devCookie, outsiderPerm)).json() as WhoCanResponse;
    expect(instanceList.people.map((p) => p.userId)).not.toContain(seed.outsider);
  });
});

describe("«Cosa può fare?»", () => {
  it("i permessi d'istanza e, per ogni progetto che chi guarda vede, quelli della persona coi motivi", async () => {
    const body = (await whatCan(adminCookie, seed.viewerWithGrant)).json() as WhatCanResponse;
    expect(body.projects.map((p) => p.projectId)).toEqual([projectA]);
    const run = body.projects[0]!.permissions.find((p) => p.permission === "runs.start")!;
    expect(run.reasons).toEqual([expect.objectContaining({ kind: "grant" })]);
    const one = (await whatCan(adminCookie, seed.dev, projectA)).json() as WhatCanResponse;
    expect(one.projects).toHaveLength(1);
  });

  it("NEGATIVI: un progetto invisibile (404, e assente dall'elenco), una persona invisibile (404), una disattivata (404)", async () => {
    const devCookie = await fullSessionCookie(app, seed.dev);
    expect((await whatCan(devCookie, seed.dev, projectB)).statusCode).toBe(404);
    const self = (await whatCan(devCookie, seed.dev)).json() as WhatCanResponse;
    expect(self.projects.map((p) => p.projectId)).not.toContain(projectB);
    // L'admin vede B, il dev no: anche se l'admin ci ha i permessi, al dev non compare.
    const adminSeenByDev = (await whatCan(devCookie, adminId)).json() as WhatCanResponse;
    expect(adminSeenByDev.projects.map((p) => p.projectId)).toEqual([projectA]);
    expect((await whatCan(devCookie, seed.outsider)).statusCode).toBe(404);
    expect((await whatCan(adminCookie, seed.deactivated)).statusCode).toBe(404);
  });
});
