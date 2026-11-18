import { randomUUID } from "node:crypto";
import { changeLog, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, seedUsers } from "../test/fixtures.js";

/** Area 9, F2, Task 7: il registro sui membri dei progetti. */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
let adminId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 10).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.com")))[0]!.id;
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const preset = async (key: string) => (await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, key)))[0]!.id;
async function person() {
  const [u] = await db.insert(users).values({ email: `m-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id, email: users.email });
  return u!;
}
const of = (projectId: string, userId: string) =>
  db.select().from(changeLog).where(and(eq(changeLog.projectId, projectId), eq(changeLog.subjectId, userId))).orderBy(desc(changeLog.at));
const put = (projectId: string, userId: string, body: object) =>
  app.inject({ method: "PUT", url: `/api/projects/${projectId}/members/${userId}`, headers: { cookie: adminCookie }, payload: body });

describe("il registro: i membri", () => {
  it("aggiunto, ruolo cambiato, un permesso dato e uno tolto (una voce per permesso), tolto; tutte nel progetto", async () => {
    const { projectId } = await seedRepository(db);
    await addMember(app, projectId, (await person()).id, "project_lead");
    const p = await person();
    expect((await put(projectId, p.id, { roleId: await preset("developer") })).statusCode).toBe(200);
    expect((await put(projectId, p.id, { roleId: await preset("viewer"), permissions: ["release.merge"] })).statusCode).toBe(200);
    expect((await put(projectId, p.id, { roleId: await preset("viewer"), permissions: ["plans.approve"] })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/members/${p.id}`, headers: { cookie: adminCookie } })).statusCode).toBe(204);
    // Le voci di UNA transazione hanno lo stesso `at` (now() è fisso lì): si
    // confronta l'insieme, e ogni voce per il suo contenuto.
    const rows = await of(projectId, p.id);
    expect(rows.map((r) => r.type).sort()).toEqual([
      "member.added",
      "member.permission_granted",
      "member.permission_granted",
      "member.permission_revoked",
      "member.removed",
      "member.role_changed",
    ]);
    expect(rows.every((r) => r.projectId === projectId && r.actorUserId === adminId)).toBe(true);
    const one = (type: string) => rows.filter((r) => r.type === type).map((r) => r.data);
    expect(one("member.added")[0]).toMatchObject({ object: { type: "member", id: p.id, label: p.email }, after: "Developer" });
    expect(one("member.role_changed")[0]).toMatchObject({ before: "Developer", after: "Viewer" });
    expect(one("member.permission_granted").map((d) => (d as { params: { permission: string } }).params.permission).sort()).toEqual(["plans.approve", "release.merge"]);
    expect(one("member.permission_revoked")[0]).toMatchObject({ params: { permission: "release.merge" } });
    expect(one("member.removed")[0]).toMatchObject({ before: "Viewer" });
  });

  it("un salvataggio con lo stesso ruolo e gli stessi permessi non scrive nulla; uno rifiutato (l'ultimo gestore) non lascia voci", async () => {
    const { projectId } = await seedRepository(db);
    const lead = await person();
    await addMember(app, projectId, lead.id, "project_lead");
    const before = (await of(projectId, lead.id)).length;
    expect((await put(projectId, lead.id, { roleId: await preset("project_lead") })).statusCode).toBe(200);
    expect(await of(projectId, lead.id)).toHaveLength(before);
    expect((await put(projectId, lead.id, { roleId: await preset("developer") })).statusCode).toBe(409);
    expect(await of(projectId, lead.id)).toHaveLength(before);
  });

  it("chi crea un progetto ne entra come lead, e lo dice il registro", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: adminCookie }, payload: { name: `Prog ${randomUUID().slice(0, 4)}` } });
    expect(res.statusCode).toBe(201);
    const projectId = (res.json() as { id: string }).id;
    const [e] = await of(projectId, adminId);
    expect(e).toMatchObject({ type: "member.added", actorUserId: adminId });
  });
});
