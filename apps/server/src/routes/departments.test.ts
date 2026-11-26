import { randomBytes } from "node:crypto";
import { departmentMembers, departments, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedTicket, startTestDb } from "@stubwise/db/testing";
import { departmentViewSchema } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { SeededUsers } from "../test/fixtures.js";
import { seedUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let defaultId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
  const [d] = await testDb.db.select({ id: departments.id }).from(departments).where(eq(departments.isDefault, true));
  defaultId = d!.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function create(name: string): Promise<string> {
  const res = await call("POST", "/api/departments", users.adminCookie, { name, colorToken: "--dept-3" });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

describe("/api/departments", () => {
  it("ogni persona li legge, nella forma condivisa, col ripiego", async () => {
    const res = await call("GET", "/api/departments", users.memberCookie);
    expect(res.statusCode).toBe(200);
    const list = departmentViewSchema.array().parse(res.json());
    expect(list.find((d) => d.isDefault)?.name).toBe("General");
  });

  it("un member senza departments.manage → 403 e reparto invariato", async () => {
    const id = await create("Vendite");
    const post = await call("POST", "/api/departments", users.memberCookie, { name: "X", colorToken: "--dept-2" });
    expect(post.statusCode).toBe(403);
    const patch = await call("PATCH", `/api/departments/${id}`, users.memberCookie, { name: "Rinominato" });
    expect(patch.statusCode).toBe(403);
    const del = await call("DELETE", `/api/departments/${id}`, users.memberCookie);
    expect(del.statusCode).toBe(403);
    const [row] = await testDb.db.select().from(departments).where(eq(departments.id, id));
    expect(row!.name).toBe("Vendite");
  });

  it("un nome già usato (senza distinguere maiuscole) → 409", async () => {
    await create("Marketing");
    const res = await call("POST", "/api/departments", users.adminCookie, { name: "marketing", colorToken: "--dept-1" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "department_name_taken" });
  });

  it("memberIds sostituisce l'insieme e mette il reparto per ultimo fra quelli della persona", async () => {
    const id = await create("Supporto");
    const res = await call("PATCH", `/api/departments/${id}`, users.adminCookie, {
      memberIds: [users.memberId],
      colorToken: "--dept-5",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ colorToken: "--dept-5" });
    const rows = await testDb.db
      .select({ d: departmentMembers.departmentId, p: departmentMembers.position })
      .from(departmentMembers)
      .where(eq(departmentMembers.userId, users.memberId));
    const general = rows.find((r) => r.d === defaultId)!;
    const support = rows.find((r) => r.d === id)!;
    expect(support.p).toBeGreaterThan(general.p);
    const out = await call("PATCH", `/api/departments/${id}`, users.adminCookie, { memberIds: [] });
    expect(out.statusCode).toBe(200);
    const left = await testDb.db
      .select()
      .from(departmentMembers)
      .where(and(eq(departmentMembers.departmentId, id), eq(departmentMembers.userId, users.memberId)));
    expect(left).toHaveLength(0);
  });

  it("una persona che non esiste in memberIds → 400 e insieme invariato", async () => {
    const id = await create("Legale");
    const res = await call("PATCH", `/api/departments/${id}`, users.adminCookie, {
      memberIds: ["00000000-0000-4000-8000-000000000000"],
    });
    expect(res.statusCode).toBe(400);
    expect(await testDb.db.select().from(departmentMembers).where(eq(departmentMembers.departmentId, id))).toHaveLength(0);
  });

  it("eliminare il ripiego → 400 department_is_default, e resta", async () => {
    const res = await call("DELETE", `/api/departments/${defaultId}`, users.adminCookie);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "department_is_default" });
    expect(await testDb.db.select().from(departments).where(eq(departments.id, defaultId))).toHaveLength(1);
  });

  it("eliminare un reparto con task senza moveTasksTo → 400; con moveTasksTo le task si spostano", async () => {
    const id = await create("Prodotto");
    const { ticketId } = await seedTicket(testDb.db);
    await testDb.db.update(tickets).set({ departmentId: id }).where(eq(tickets.id, ticketId));
    const bare = await call("DELETE", `/api/departments/${id}`, users.adminCookie);
    expect(bare.statusCode).toBe(400);
    expect(bare.json()).toMatchObject({ code: "department_has_tasks" });
    const self = await call("DELETE", `/api/departments/${id}?moveTasksTo=${id}`, users.adminCookie);
    expect(self.statusCode).toBe(400);
    const moved = await call("DELETE", `/api/departments/${id}?moveTasksTo=${defaultId}`, users.adminCookie);
    expect(moved.statusCode).toBe(204);
    const [t] = await testDb.db.select({ d: tickets.departmentId }).from(tickets).where(eq(tickets.id, ticketId));
    expect(t!.d).toBe(defaultId);
    expect(await testDb.db.select().from(departments).where(eq(departments.id, id))).toHaveLength(0);
  });

  it("spostare le task di un reparto eliminato non tocca il loro updated_at", async () => {
    const id = await create("Ricerca");
    const { ticketId } = await seedTicket(testDb.db);
    await testDb.db.execute(sql`update tickets set department_id = ${id}, updated_at = now() - interval '3 days' where id = ${ticketId}`);
    const [pre] = await testDb.db.select({ u: tickets.updatedAt }).from(tickets).where(eq(tickets.id, ticketId));
    const res = await call("DELETE", `/api/departments/${id}?moveTasksTo=${defaultId}`, users.adminCookie);
    expect(res.statusCode).toBe(204);
    const [post] = await testDb.db.select({ u: tickets.updatedAt, d: tickets.departmentId }).from(tickets).where(eq(tickets.id, ticketId));
    expect(post).toEqual({ u: pre!.u, d: defaultId });
  });

  it("un reparto inesistente → 404", async () => {
    const res = await call("PATCH", "/api/departments/00000000-0000-4000-8000-000000000000", users.adminCookie, {
      name: "x",
    });
    expect(res.statusCode).toBe(404);
  });
});
