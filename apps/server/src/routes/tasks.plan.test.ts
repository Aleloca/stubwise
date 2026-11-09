import { randomBytes } from "node:crypto";
import { departments, notifications, ticketFollowers, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { currentIsoWeek, taskActivityEntryViewSchema, taskListResponseSchema, taskViewSchema } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
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

const cardsOf = async (userId: string, ticketId: string, kind: "planning.changed" | "task.assigned" | "ticket.activity") =>
  testDb.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.ticketId, ticketId), eq(notifications.kind, kind)));

const followedBy = (ticketId: string, ...userIds: string[]) =>
  testDb.db.insert(ticketFollowers).values(userIds.map((userId) => ({ ticketId, userId }))).onConflictDoNothing();

describe("avvisi della pianificazione (planning.changed, task.assigned)", () => {
  it("spostata da un Project Lead → planning.changed a chi l'aveva, non all'attore", async () => {
    const id = await task(dev.id, "2030-01-07");
    await followedBy(id, dev.id, lead.id);
    expect((await plan(id, { assigneeId: dev.id, week: "2030-W05" }, lead.headers.cookie)).statusCode).toBe(200);
    const cards = await cardsOf(dev.id, id, "planning.changed");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.event).toMatchObject({
      kind: "planning.changed",
      fromWeek: "2030-W02",
      toWeek: "2030-W05",
      fromAssigneeId: dev.id,
      toAssigneeId: dev.id,
      actorUserId: lead.id,
    });
    expect(await cardsOf(lead.id, id, "planning.changed")).toHaveLength(0);
  });

  it("data a un'altra persona: planning.changed a chi l'aveva, task.assigned a chi la riceve, e niente ticket.activity doppia per loro", async () => {
    const id = await task(dev.id, "2030-01-07");
    await followedBy(id, dev.id, other.id, users.adminId);
    expect((await plan(id, { assigneeId: other.id, week: "2030-W05" }, lead.headers.cookie)).statusCode).toBe(200);
    const lost = await cardsOf(dev.id, id, "planning.changed");
    expect(lost).toHaveLength(1);
    expect(lost[0]!.event).toMatchObject({ toAssigneeId: other.id, toAssigneeName: "altro" });
    expect(await cardsOf(other.id, id, "task.assigned")).toHaveLength(1);
    expect(await cardsOf(other.id, id, "planning.changed")).toHaveLength(0);
    // Chi ha già la card precisa non riceve anche l'attività; gli altri follower sì.
    expect(await cardsOf(dev.id, id, "ticket.activity")).toHaveLength(0);
    expect(await cardsOf(other.id, id, "ticket.activity")).toHaveLength(0);
    expect(await cardsOf(users.adminId, id, "ticket.activity")).toHaveLength(1);
  });

  it("presa per sé → nessun avviso", async () => {
    const id = await task(null);
    expect((await plan(id, { assigneeId: dev.id, week: "2030-W02" }, dev.headers.cookie)).statusCode).toBe(200);
    expect(await cardsOf(dev.id, id, "planning.changed")).toHaveLength(0);
    expect(await cardsOf(dev.id, id, "task.assigned")).toHaveLength(0);
    // E spostare la propria nemmeno.
    expect((await plan(id, { assigneeId: dev.id, week: "2030-W03" }, dev.headers.cookie)).statusCode).toBe(200);
    expect(await cardsOf(dev.id, id, "planning.changed")).toHaveLength(0);
  });

  it("un'assegnazione da PATCH avvisa chi la riceve con task.assigned; non chi si assegna da sé", async () => {
    const id = await task(null);
    const patch = (assigneeId: string, cookie: string) =>
      app.inject({ method: "PATCH", url: `/api/tasks/${id}`, headers: { cookie }, payload: { assigneeId } });
    expect((await patch(other.id, lead.headers.cookie)).statusCode).toBe(200);
    expect(await cardsOf(other.id, id, "task.assigned")).toHaveLength(1);
    expect((await patch(lead.id, lead.headers.cookie)).statusCode).toBe(200);
    expect(await cardsOf(lead.id, id, "task.assigned")).toHaveLength(0);
    // Il planning.changed resta della rotta di pianificazione.
    expect(await cardsOf(other.id, id, "planning.changed")).toHaveLength(0);
  });

  it("chi non vede la task non riceve l'avviso", async () => {
    const id = await task(null);
    expect((await plan(id, { assigneeId: outsider.id, week: null }, lead.headers.cookie)).statusCode).toBe(400);
    expect(await cardsOf(outsider.id, id, "task.assigned")).toHaveLength(0);
    // Un membro senza `tickets.view_all` (Contributor) può riceverla, ma non la vede: nessuna card.
    const contributor = await createUserWithSession(app, "contrib@example.com");
    await addMember(app, projectId, contributor.id, "contributor");
    expect((await plan(id, { assigneeId: contributor.id, week: "2030-W05" }, lead.headers.cookie)).statusCode).toBe(200);
    expect(await cardsOf(contributor.id, id, "task.assigned")).toHaveLength(0);
    expect((await plan(id, { assigneeId: lead.id, week: "2030-W05" }, lead.headers.cookie)).statusCode).toBe(200);
    expect(await cardsOf(contributor.id, id, "planning.changed")).toHaveLength(0);
  });
});

describe("attività: settimana, reparto e taglia (solo scritture umane)", () => {
  const activity = async (id: string) =>
    z
      .array(taskActivityEntryViewSchema)
      .parse(
        (await app.inject({ method: "GET", url: `/api/tasks/${id}/activity`, headers: { cookie: lead.headers.cookie } })).json(),
      )
      .filter((e) => e.kind === "field_change");

  it("la settimana va da quella EFFETTIVA di prima (slittamento compreso) a quella nuova", async () => {
    // Pianificata in una settimana passata: oggi è slittata alla corrente.
    const id = await task(dev.id, "2026-01-05");
    expect((await plan(id, { assigneeId: dev.id, week: "2030-W05" }, lead.headers.cookie)).statusCode).toBe(200);
    const week = (await activity(id)).filter((e) => e.field === "week");
    expect(week).toEqual([expect.objectContaining({ from: currentIsoWeek(new Date()), to: "2030-W05", authorId: lead.id })]);
  });

  it("reparto per nome e taglia XS–XL; nessun evento se non cambia niente", async () => {
    const [dept] = await testDb.db
      .insert(departments)
      .values({ name: "Design", colorToken: "--dept-2" })
      .returning({ id: departments.id });
    const id = await task(dev.id);
    const patch = (payload: object) =>
      app.inject({ method: "PATCH", url: `/api/tasks/${id}`, headers: { cookie: lead.headers.cookie }, payload });
    expect((await patch({ departmentId: dept!.id, size: "M" })).statusCode).toBe(200);
    expect((await patch({ size: "XL" })).statusCode).toBe(200);
    expect((await patch({ size: "XL", departmentId: dept!.id })).statusCode).toBe(200);
    const entries = await activity(id);
    const [general] = await testDb.db
      .select({ name: departments.name })
      .from(departments)
      .where(eq(departments.isDefault, true));
    expect(entries.filter((e) => e.field === "department")).toEqual([
      expect.objectContaining({ from: general!.name, to: "Design" }),
    ]);
    expect(entries.filter((e) => e.field === "size").map((e) => [e.from, e.to])).toEqual([
      [null, "M"],
      ["M", "XL"],
    ]);
  });
});
