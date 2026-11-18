import { randomUUID } from "node:crypto";
import { changeLog, roles, users, type Db } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

/** Area 9, F2, Task 6: il registro su ruoli e reparti. */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: Buffer.alloc(32, 9).toString("base64") });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const as = (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: adminCookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const of = (subjectId: string, type: string) =>
  db.select().from(changeLog).where(and(eq(changeLog.subjectId, subjectId), eq(changeLog.type, type))).orderBy(desc(changeLog.at));
async function person() {
  const [u] = await db.insert(users).values({ email: `d-${randomUUID().slice(0, 6)}@acme.com`, passwordHash: "x", role: "member" }).returning({ id: users.id, email: users.email });
  return u!;
}

describe("il registro: i ruoli", () => {
  it("creato, duplicato (con l'origine), aggiornato (permessi aggiunti e tolti, nome), eliminato", async () => {
    const name = `Rel ${randomUUID().slice(0, 4)}`;
    const created = await as("POST", "/api/roles", { name, scope: "project", permissions: ["tickets.view_all"] });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    expect((await of(id, "role.created"))[0]!.data).toMatchObject({ object: { type: "role", id, label: name } });
    const copy = await as("POST", `/api/roles/${id}/duplicate`, {});
    const copyId = (copy.json() as { id: string }).id;
    expect((await of(copyId, "role.created"))[0]!.data).toMatchObject({ params: { from: name } });
    expect((await as("PATCH", `/api/roles/${id}`, { name: `${name} 2`, permissions: ["release.merge"] })).statusCode).toBe(200);
    const [u] = await of(id, "role.updated");
    expect(u!.data).toMatchObject({ before: name, after: `${name} 2`, params: { added: ["release.merge"], removed: ["tickets.view_all"] } });
    expect((await as("DELETE", `/api/roles/${id}`)).statusCode).toBe(204);
    expect((await of(id, "role.deleted"))[0]!.data).toMatchObject({ object: { label: `${name} 2` } });
  });

  it("un aggiornamento rifiutato DOPO la voce (togliere il full admin all'ultimo) non la lascia", async () => {
    const [admin] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "admin"));
    expect((await as("PATCH", `/api/roles/${admin!.id}`, { permissions: ["users.manage"] })).statusCode).toBe(409);
    expect(await of(admin!.id, "role.updated")).toHaveLength(0);
  });
});

describe("il registro: i reparti", () => {
  it("creato, rinominato, persone entrate e uscite (id e nomi), gestori della Home, eliminato", async () => {
    const a = await person();
    const b = await person();
    const created = await as("POST", "/api/departments", { name: `Rep ${randomUUID().slice(0, 4)}`, colorToken: "--dept-1" });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    expect(await of(id, "department.created")).toHaveLength(1);
    expect((await as("PATCH", `/api/departments/${id}`, { name: "Rinominato", memberIds: [a.id, b.id] })).statusCode).toBe(200);
    expect((await of(id, "department.updated"))[0]!.data).toMatchObject({ after: "Rinominato" });
    expect((await of(id, "department.members_changed"))[0]!.data).toMatchObject({ params: { added: expect.arrayContaining([a.id, b.id]), removed: [] } });
    expect((await as("PATCH", `/api/departments/${id}`, { memberIds: [a.id] })).statusCode).toBe(200);
    expect((await of(id, "department.members_changed"))[0]!.data).toMatchObject({ params: { added: [], removed: [b.id], removedNames: [b.email] } });
    expect((await as("PUT", `/api/departments/${id}/roles`, { roles: [{ userId: a.id, permissions: ["department.home.manage"] }] })).statusCode).toBe(200);
    expect((await of(id, "department.home_managers_changed"))[0]!.data).toMatchObject({ params: { added: [a.id], removed: [] } });
    expect((await as("DELETE", `/api/departments/${id}`)).statusCode).toBe(204);
    expect(await of(id, "department.deleted")).toHaveLength(1);
  });

  it("un PATCH con le STESSE persone non scrive members_changed", async () => {
    const created = await as("POST", "/api/departments", { name: `Rep ${randomUUID().slice(0, 4)}`, colorToken: "--dept-2" });
    const id = (created.json() as { id: string }).id;
    const c = await person();
    expect((await as("PATCH", `/api/departments/${id}`, { memberIds: [c.id] })).statusCode).toBe(200);
    expect(await of(id, "department.members_changed")).toHaveLength(1);
    expect((await as("PATCH", `/api/departments/${id}`, { colorToken: "--dept-3", memberIds: [c.id] })).statusCode).toBe(200);
    expect(await of(id, "department.members_changed")).toHaveLength(1);
    expect(await of(id, "department.updated")).toHaveLength(1);
  });
});
