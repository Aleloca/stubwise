import { randomBytes } from "node:crypto";
import { tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { taskListResponseSchema, taskViewSchema } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * La pianificazione dal server (integrazione area 2, fetta 2): `planBlock` di
 * `@stubwise/shared` decide sulla rotta `plan`, coi diritti calcolati dal
 * server; `TaskView.canPlan` lo dice per chi guarda. PATCH e bulk restano su
 * `tickets.edit`, come nel prototipo (`prepareTaskPatch`).
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let lead: { id: string; headers: { cookie: string } };
let dev: { id: string; headers: { cookie: string } };
let other: { id: string; headers: { cookie: string } };
let outsider: { id: string; headers: { cookie: string } };
let n = 0;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  lead = await createUserWithSession(app, "lead@example.com");
  dev = await createUserWithSession(app, "dev@example.com");
  other = await createUserWithSession(app, "altro@example.com");
  outsider = await createUserWithSession(app, "fuori@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, dev.id, "developer");
  await addMember(app, projectId, other.id, "developer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function task(assigneeId: string | null, plannedWeek: string | null = null): Promise<string> {
  n += 1;
  const [row] = await testDb.db
    .insert(tickets)
    .values({
      projectId,
      number: n,
      title: `T${n}`,
      type: "bug",
      priority: "medium",
      source: "manual",
      assigneeId,
      plannedWeek,
    })
    .returning({ id: tickets.id });
  return row!.id;
}

const plan = (ticketId: string, body: unknown, cookie: string) =>
  app.inject({ method: "POST", url: `/api/tasks/${ticketId}/plan`, headers: { cookie }, payload: body as object });

const rowOf = async (ticketId: string) =>
  (await testDb.db
    .select({ a: tickets.assigneeId, w: tickets.plannedWeek })
    .from(tickets)
    .where(eq(tickets.id, ticketId)))[0]!;

describe("POST /api/tasks/:ticketId/plan", () => {
  it("un Developer sposta una task altrui → 403 e riga invariata", async () => {
    const id = await task(other.id, "2030-01-07");
    const before = await rowOf(id);
    const res = await plan(id, { assigneeId: other.id, week: "2030-W03" }, dev.headers.cookie);
    expect(res.statusCode).toBe(403);
    expect(await rowOf(id)).toEqual(before);
    // Né prenderla per sé.
    expect((await plan(id, { assigneeId: dev.id, week: "2030-W03" }, dev.headers.cookie)).statusCode).toBe(403);
    expect(await rowOf(id)).toEqual(before);
  });

  it("un Developer prende per sé una non assegnata (tickets.edit), e sposta la sua", async () => {
    const id = await task(null);
    const res = await plan(id, { assigneeId: dev.id, week: "2030-W02" }, dev.headers.cookie);
    expect(res.statusCode).toBe(200);
    expect(taskViewSchema.parse(res.json())).toMatchObject({ assigneeId: dev.id, plannedWeek: "2030-W02" });
    const moved = await plan(id, { assigneeId: dev.id, week: "2030-W04" }, dev.headers.cookie);
    expect(moved.statusCode).toBe(200);
    expect(await rowOf(id)).toEqual({ a: dev.id, w: "2030-01-21" });
  });

  it("un Project Lead sposta chiunque, anche a un'altra persona", async () => {
    const id = await task(dev.id, "2030-01-07");
    const res = await plan(id, { assigneeId: other.id, week: "2030-W05" }, lead.headers.cookie);
    expect(res.statusCode).toBe(200);
    expect(await rowOf(id)).toEqual({ a: other.id, w: "2030-01-28" });
  });

  it("un full admin è un membro implicito: gli si può pianificare una task", async () => {
    const id = await task(null);
    expect((await plan(id, { assigneeId: users.adminId, week: "2030-W05" }, lead.headers.cookie)).statusCode).toBe(200);
  });

  it("un assegnatario che non è membro del progetto → 400 invalid_assignee", async () => {
    const id = await task(null);
    const res = await plan(id, { assigneeId: outsider.id, week: "2030-W05" }, lead.headers.cookie);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_assignee" });
    expect(await rowOf(id)).toEqual({ a: null, w: null });
  });

  it("una task di un progetto invisibile → 404", async () => {
    const id = await task(null);
    expect((await plan(id, { assigneeId: outsider.id, week: null }, outsider.headers.cookie)).statusCode).toBe(404);
  });

  it("una settimana che non esiste → 400", async () => {
    const id = await task(lead.id);
    expect((await plan(id, { assigneeId: lead.id, week: "2027-W53" }, lead.headers.cookie)).statusCode).toBe(400);
  });
});

describe("TaskView.canPlan", () => {
  it("falso sulle task altrui per il Developer, vero sulle sue e sulle non assegnate; vero ovunque per il Project Lead", async () => {
    const mine = await task(dev.id);
    const theirs = await task(other.id);
    const free = await task(null);
    const view = async (cookie: string) =>
      taskListResponseSchema.parse(
        (await app.inject({ method: "GET", url: `/api/tasks?projectIds=${projectId}`, headers: { cookie } })).json(),
      ).items;
    const forDev = await view(dev.headers.cookie);
    expect(forDev.find((t) => t.id === mine)?.canPlan).toBe(true);
    expect(forDev.find((t) => t.id === free)?.canPlan).toBe(true);
    expect(forDev.find((t) => t.id === theirs)?.canPlan).toBe(false);
    const forLead = await view(lead.headers.cookie);
    expect(forLead.find((t) => t.id === theirs)?.canPlan).toBe(true);
  });

  it("PATCH resta su tickets.edit, come nel prototipo: il Developer cambia la settimana di una task altrui", async () => {
    const theirs = await task(other.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${theirs}`,
      headers: { cookie: dev.headers.cookie },
      payload: { plannedWeek: "2030-W06" },
    });
    expect(res.statusCode).toBe(200);
  });
});
