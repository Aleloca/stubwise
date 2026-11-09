import { randomBytes } from "node:crypto";
import {
  backlogItemTickets,
  backlogJobs,
  departmentMembers,
  departments,
  projectStatuses,
  projects,
  ticketEvents,
  ticketFollowers,
  tickets,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { addDepartmentMember, seedBacklogItem, seedDepartment, seedRepository, startTestDb } from "@stubwise/db/testing";
import { stalledTaskViewSchema, taskViewSchema } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
/** Progetto col backlog acceso, in cui il member è Project Lead. */
let projectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  await testDb.db.update(projects).set({ backlogEnabled: true }).where(eq(projects.id, projectId));
  await addMember(app, projectId, users.memberId, "project_lead");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function statusId(pid: string, name: string): Promise<string> {
  const [row] = await testDb.db
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, pid), eq(projectStatuses.name, name)));
  return row!.id;
}

const send = (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, cookie = users.memberCookie) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function createTask(body: Record<string, unknown> = {}, cookie = users.memberCookie) {
  const res = await send("POST", "/api/tasks", { projectId, title: "Nuova", type: "bug", ...body }, cookie);
  expect(res.statusCode, res.body).toBe(201);
  return taskViewSchema.parse(res.json());
}

describe("POST /api/tasks", () => {
  it("una feature creata da /api/tasks su un progetto col backlog acceso NON va all'intake", async () => {
    const task = await createTask({ type: "feature" });
    expect(task.type).toBe("feature");
    const [row] = await testDb.db.select({ type: tickets.type }).from(tickets).where(eq(tickets.id, task.id));
    expect(row!.type).toBe("feature");
    expect(await testDb.db.select().from(backlogJobs)).toHaveLength(0);
  });

  it("nasce nel primo reparto di chi crea e nel primo todo; chi crea e l'assegnatario seguono", async () => {
    const first = await seedDepartment(testDb.db, { name: "Primo" });
    const second = await seedDepartment(testDb.db, { name: "Secondo" });
    const person = await createUserWithSession(app, "creatrice@example.com");
    await addMember(app, projectId, person.id, "project_lead");
    // La migrazione l'ha messa nel ripiego a 0: i suoi reparti, in ordine, diventano Primo, Secondo, General.
    await testDb.db.delete(departmentMembers).where(eq(departmentMembers.userId, person.id));
    await addDepartmentMember(testDb.db, second.id, person.id, 1);
    await addDepartmentMember(testDb.db, first.id, person.id, 0);
    const task = await createTask({ assigneeId: users.memberId }, person.headers.cookie);
    expect(task.departmentId).toBe(first.id);
    expect(task.statusId).toBe(await statusId(projectId, "To do"));
    expect(task.createdById).toBe(person.id);
    expect([...task.followerIds].sort()).toEqual([person.id, users.memberId].sort());
  });

  it("una persona senza reparti crea nel ripiego", async () => {
    await testDb.db.delete(departmentMembers).where(eq(departmentMembers.userId, users.memberId));
    const [general] = await testDb.db.select({ id: departments.id }).from(departments).where(eq(departments.isDefault, true));
    const task = await createTask();
    expect(task.departmentId).toBe(general!.id);
    await addDepartmentMember(testDb.db, general!.id, users.memberId, 0);
  });

  it("stato, taglia, scadenza e richiesta d'origine dal body", async () => {
    const { itemId } = await seedBacklogItem(testDb.db, { projectId });
    const inProgress = await statusId(projectId, "In progress");
    const task = await createTask({ statusId: inProgress, size: "L", requestId: itemId, type: "activity" });
    expect(task).toMatchObject({ statusId: inProgress, size: "L", requestId: itemId, type: "activity" });
    const [row] = await testDb.db
      .select({ effort: tickets.effort, status: tickets.status, type: tickets.type })
      .from(tickets)
      .where(eq(tickets.id, task.id));
    expect(row).toEqual({ effort: 4, status: "in_progress", type: "task" });
    const links = await testDb.db.select().from(backlogItemTickets).where(eq(backlogItemTickets.ticketId, task.id));
    expect(links).toMatchObject([{ itemId, role: "converted_to" }]);
  });

  it("uno stato di un altro progetto → 400 e nessun ticket", async () => {
    const other = (await seedRepository(testDb.db)).projectId;
    const before = (await testDb.db.select().from(tickets)).length;
    const res = await send("POST", "/api/tasks", {
      projectId,
      title: "x",
      type: "bug",
      statusId: await statusId(other, "To do"),
    });
    expect(res.statusCode).toBe(400);
    expect((await testDb.db.select().from(tickets)).length).toBe(before);
  });

  it("un Viewer senza tickets.create → 403 e nessun ticket", async () => {
    const { projectId: pid } = await seedRepository(testDb.db);
    await addMember(app, pid, users.memberId, "viewer");
    const before = (await testDb.db.select().from(tickets)).length;
    const res = await send("POST", "/api/tasks", { projectId: pid, title: "x", type: "bug" });
    expect(res.statusCode).toBe(403);
    expect((await testDb.db.select().from(tickets)).length).toBe(before);
  });
});

describe("PATCH /api/tasks/:ticketId", () => {
  it("PATCH statusId riscrive l'enum (via trigger) e scrive status_changed con gli id degli stati", async () => {
    const task = await createTask();
    const inReview = await statusId(projectId, "In review");
    const res = await send("PATCH", `/api/tasks/${task.id}`, { statusId: inReview });
    expect(res.statusCode).toBe(200);
    expect(taskViewSchema.parse(res.json()).statusId).toBe(inReview);
    const [row] = await testDb.db.select({ status: tickets.status }).from(tickets).where(eq(tickets.id, task.id));
    expect(row!.status).toBe("in_review");
    const events = await testDb.db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, task.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "status_changed",
      actorId: users.memberId,
      payload: { from: "open", to: "in_review", fromStatusId: task.statusId, toStatusId: inReview },
    });
  });

  it("PATCH type feature su un feedback non lo riscrive; activity lo riscrive come task", async () => {
    const task = await createTask();
    await testDb.db.update(tickets).set({ type: "feedback" }).where(eq(tickets.id, task.id));
    await send("PATCH", `/api/tasks/${task.id}`, { type: "feature" });
    const read = async () =>
      (await testDb.db.select({ type: tickets.type }).from(tickets).where(eq(tickets.id, task.id)))[0]!.type;
    expect(await read()).toBe("feedback");
    await send("PATCH", `/api/tasks/${task.id}`, { type: "activity" });
    expect(await read()).toBe("task");
  });

  it("una scadenza impostata si rilegge, e si toglie", async () => {
    const task = await createTask();
    const set = await send("PATCH", `/api/tasks/${task.id}`, { dueDate: "2026-12-24" });
    expect(taskViewSchema.parse(set.json()).dueDate).toBe("2026-12-24");
    const cleared = await send("PATCH", `/api/tasks/${task.id}`, { dueDate: null });
    expect(taskViewSchema.parse(cleared.json()).dueDate).toBeNull();
  });

  it("un nuovo assegnatario diventa follower; taglia e reparto si salvano", async () => {
    const task = await createTask();
    const dept = await seedDepartment(testDb.db, { name: "Patch" });
    const res = await send("PATCH", `/api/tasks/${task.id}`, {
      assigneeId: users.adminId,
      size: "XS",
      departmentId: dept.id,
    });
    const view = taskViewSchema.parse(res.json());
    expect(view).toMatchObject({ assigneeId: users.adminId, size: "XS", departmentId: dept.id });
    expect(view.followerIds).toContain(users.adminId);
  });

  it("un Viewer non modifica → 403 e task invariata", async () => {
    const task = await createTask();
    const viewer = await createUserWithSession(app, "solo-lettura@example.com");
    await addMember(app, projectId, viewer.id, "viewer");
    const res = await send("PATCH", `/api/tasks/${task.id}`, { title: "Cambiato" }, viewer.headers.cookie);
    expect(res.statusCode).toBe(403);
    const [row] = await testDb.db.select({ title: tickets.title }).from(tickets).where(eq(tickets.id, task.id));
    expect(row!.title).toBe("Nuova");
  });
});

describe("PATCH /api/tasks/bulk", () => {
  it("bulk con una task non modificabile → 403 e nessuna task cambiata", async () => {
    const mine = await createTask();
    const { projectId: pid } = await seedRepository(testDb.db);
    await addMember(app, pid, users.memberId, "viewer");
    const [theirs] = await testDb.db
      .insert(tickets)
      .values({ projectId: pid, number: 1, title: "Altrui", type: "bug", priority: "medium", source: "manual" })
      .returning({ id: tickets.id });
    const res = await send("PATCH", "/api/tasks/bulk", { ids: [mine.id, theirs!.id], patch: { size: "XL" } });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { codes: string[] }).codes).toHaveLength(1);
    const rows = await testDb.db.select({ effort: tickets.effort }).from(tickets).where(eq(tickets.id, mine.id));
    expect(rows[0]!.effort).toBeNull();
  });

  it("bulk su task modificabili le cambia tutte", async () => {
    const a = await createTask();
    const b = await createTask();
    const done = await statusId(projectId, "Done");
    const res = await send("PATCH", "/api/tasks/bulk", { ids: [a.id, b.id], patch: { statusId: done, size: "S" } });
    expect(res.statusCode).toBe(200);
    const views = taskViewSchema.array().parse(res.json());
    expect(views.map((v) => [v.statusId, v.size])).toEqual([
      [done, "S"],
      [done, "S"],
    ]);
  });

  it("statusId su task di progetti diversi → 400 status_cross_project", async () => {
    const a = await createTask();
    const { projectId: pid } = await seedRepository(testDb.db);
    await addMember(app, pid, users.memberId, "project_lead");
    const b = await createTask({ projectId: pid });
    const res = await send("PATCH", "/api/tasks/bulk", {
      ids: [a.id, b.id],
      patch: { statusId: await statusId(projectId, "Done") },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "status_cross_project" });
  });
});

describe("ferma a mano e follow", () => {
  it("manual-stall si imposta e si toglie, e compare in /stalled", async () => {
    const task = await createTask();
    const put = await send("PUT", `/api/tasks/${task.id}/manual-stall`, { reason: "Aspetta il cliente", note: "mail" });
    expect(put.statusCode).toBe(200);
    expect(taskViewSchema.parse(put.json()).manualStall).toMatchObject({
      reason: "Aspetta il cliente",
      note: "mail",
      byId: users.memberId,
    });
    const stalled = async () =>
      stalledTaskViewSchema
        .array()
        .parse((await app.inject({ method: "GET", url: `/api/tasks/stalled?projectIds=${projectId}`, headers: { cookie: users.memberCookie } })).json())
        .map((s) => s.task.id);
    expect(await stalled()).toContain(task.id);
    const del = await send("DELETE", `/api/tasks/${task.id}/manual-stall`);
    expect(del.statusCode).toBe(200);
    expect(taskViewSchema.parse(del.json()).manualStall).toBeNull();
    expect(await stalled()).not.toContain(task.id);
  });

  it("follow e unfollow sono idempotenti", async () => {
    const task = await createTask();
    const followers = async () =>
      (await testDb.db.select().from(ticketFollowers).where(eq(ticketFollowers.ticketId, task.id))).map((f) => f.userId);
    for (let i = 0; i < 2; i++) {
      expect((await send("PUT", `/api/tasks/${task.id}/follow`, undefined, users.adminCookie)).statusCode).toBe(204);
    }
    expect(await followers()).toContain(users.adminId);
    for (let i = 0; i < 2; i++) {
      expect((await send("DELETE", `/api/tasks/${task.id}/follow`, undefined, users.adminCookie)).statusCode).toBe(204);
    }
    expect(await followers()).not.toContain(users.adminId);
  });

  it("una task invisibile non si segue → 404", async () => {
    const { projectId: pid } = await seedRepository(testDb.db);
    const [hidden] = await testDb.db
      .insert(tickets)
      .values({ projectId: pid, number: 1, title: "Nascosta", type: "bug", priority: "medium", source: "manual" })
      .returning({ id: tickets.id });
    expect((await send("PUT", `/api/tasks/${hidden!.id}/follow`)).statusCode).toBe(404);
  });
});
