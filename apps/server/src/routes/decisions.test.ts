import { randomBytes } from "node:crypto";
import { decisionRequests, notifications, ticketFollowers, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { decisionRequestViewSchema } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let target: { id: string; headers: { cookie: string } };
let third: { id: string; headers: { cookie: string } };
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
  target = await createUserWithSession(app, "decide@example.com");
  third = await createUserWithSession(app, "terzo@example.com");
  outsider = await createUserWithSession(app, "fuori@example.com");
  await addMember(app, projectId, users.memberId, "project_lead");
  await addMember(app, projectId, target.id, "project_lead");
  await addMember(app, projectId, third.id, "project_lead");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function task(): Promise<string> {
  n += 1;
  const [row] = await testDb.db
    .insert(tickets)
    .values({ projectId, number: n, title: `T${n}`, type: "bug", priority: "medium", source: "manual" })
    .returning({ id: tickets.id });
  return row!.id;
}

const post = (url: string, payload: unknown, cookie = users.memberCookie) =>
  app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });

const notificationsOf = (userId: string, kind: "decision.requested" | "decision.answered" | "ticket.activity") =>
  testDb.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.kind, kind)));

async function ask(ticketId: string, payload: Record<string, unknown> = {}) {
  const res = await post(`/api/tasks/${ticketId}/decisions`, {
    askedOfId: target.id,
    question: "30 o 90 giorni?",
    options: ["30", "90"],
    ...payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return decisionRequestViewSchema.parse(res.json());
}

describe("richieste di decisione", () => {
  it("chiedere pubblica decision.requested al destinatario", async () => {
    const ticketId = await task();
    const before = (await notificationsOf(target.id, "decision.requested")).length;
    const decision = await ask(ticketId);
    expect(decision).toMatchObject({ askedById: users.memberId, askedOfId: target.id, answer: null, withdrawnAt: null });
    const after = await notificationsOf(target.id, "decision.requested");
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.event).toMatchObject({ decisionId: decision.id, question: "30 o 90 giorni?" });
    expect(await notificationsOf(users.memberId, "decision.requested")).toHaveLength(0);
  });

  it("chiedere a chi non vede la task → 400 decision_target_cannot_see", async () => {
    const ticketId = await task();
    const res = await post(`/api/tasks/${ticketId}/decisions`, { askedOfId: outsider.id, question: "?", options: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "decision_target_cannot_see" });
  });

  it("rispondere pubblica decision.answered a chi ha chiesto e chiude la richiesta", async () => {
    const ticketId = await task();
    const decision = await ask(ticketId);
    const res = await post(`/api/decisions/${decision.id}/answer`, { optionIndex: 1 }, target.headers.cookie);
    expect(res.statusCode).toBe(200);
    expect(decisionRequestViewSchema.parse(res.json()).answer).toMatchObject({ optionIndex: 1, text: null, byId: target.id });
    const answered = await notificationsOf(users.memberId, "decision.answered");
    expect(answered.at(-1)!.event).toMatchObject({ decisionId: decision.id, answerSummary: "90" });
    const again = await post(`/api/decisions/${decision.id}/answer`, { text: "altro" }, target.headers.cookie);
    expect(again.statusCode).toBe(409);
  });

  it("«Altro…»: una risposta a testo libero", async () => {
    const decision = await ask(await task());
    const res = await post(`/api/decisions/${decision.id}/answer`, { text: "Dipende dal cliente" }, target.headers.cookie);
    expect(decisionRequestViewSchema.parse(res.json()).answer).toMatchObject({ optionIndex: null, text: "Dipende dal cliente" });
  });

  it("un terzo non può rispondere → 403 e richiesta aperta", async () => {
    const decision = await ask(await task());
    const res = await post(`/api/decisions/${decision.id}/answer`, { optionIndex: 0 }, third.headers.cookie);
    expect(res.statusCode).toBe(403);
    const [row] = await testDb.db.select().from(decisionRequests).where(eq(decisionRequests.id, decision.id));
    expect(row!.answeredAt).toBeNull();
  });

  it("ritirare due volte → 409; solo chi ha chiesto ritira", async () => {
    const decision = await ask(await task());
    expect((await post(`/api/decisions/${decision.id}/withdraw`, {}, target.headers.cookie)).statusCode).toBe(403);
    expect((await post(`/api/decisions/${decision.id}/withdraw`, {})).statusCode).toBe(200);
    expect((await post(`/api/decisions/${decision.id}/withdraw`, {})).statusCode).toBe(409);
  });

  it("più richieste aperte verso persone diverse, e l'elenco delle mie aperte", async () => {
    const ticketId = await task();
    await ask(ticketId);
    await ask(ticketId, { askedOfId: third.id });
    const mine = await app.inject({
      method: "GET",
      url: `/api/decisions?askedOfId=me&open=true&taskId=${ticketId}`,
      headers: { cookie: target.headers.cookie },
    });
    expect(mine.statusCode).toBe(200);
    const list = decisionRequestViewSchema.array().parse(mine.json());
    expect(list.map((d) => d.askedOfId)).toEqual([target.id]);
    const all = await app.inject({ method: "GET", url: `/api/decisions?taskId=${ticketId}`, headers: { cookie: users.memberCookie } });
    expect(decisionRequestViewSchema.array().parse(all.json())).toHaveLength(2);
    const blind = await app.inject({ method: "GET", url: `/api/decisions?taskId=${ticketId}`, headers: { cookie: outsider.headers.cookie } });
    expect(decisionRequestViewSchema.array().parse(blind.json())).toEqual([]);
  });

  it("una decisione di una task invisibile → 404", async () => {
    const decision = await ask(await task());
    expect((await post(`/api/decisions/${decision.id}/answer`, { optionIndex: 0 }, outsider.headers.cookie)).statusCode).toBe(404);
  });
});

describe("notifiche ai follower", () => {
  it("un commento notifica i follower tranne l'autore", async () => {
    const ticketId = await task();
    await testDb.db.insert(ticketFollowers).values([
      { ticketId, userId: users.memberId },
      { ticketId, userId: third.id },
      { ticketId, userId: outsider.id },
    ]);
    const res = await post(`/api/tickets/${ticketId}/comments`, { body: "Ci guardo io" });
    expect(res.statusCode).toBe(201);
    const thirds = await notificationsOf(third.id, "ticket.activity");
    expect(thirds.at(-1)!.event).toMatchObject({ change: "comment", summary: "Ci guardo io", ticketId });
    expect((await notificationsOf(users.memberId, "ticket.activity")).filter((x) => x.ticketId === ticketId)).toHaveLength(0);
    // Chi non vede più il progetto non riceve card.
    expect((await notificationsOf(outsider.id, "ticket.activity")).filter((x) => x.ticketId === ticketId)).toHaveLength(0);
  });

  it("un cambio di stato e di assegnatario dall'app nuova notifica i follower", async () => {
    const ticketId = await task();
    await testDb.db.insert(ticketFollowers).values({ ticketId, userId: third.id });
    const statuses = await app.inject({ method: "GET", url: `/api/projects/${projectId}/statuses`, headers: { cookie: users.memberCookie } });
    const done = (statuses.json() as { id: string; name: string }[]).find((s) => s.name === "Done")!;
    await app.inject({
      method: "PATCH",
      url: `/api/tasks/${ticketId}`,
      headers: { cookie: users.memberCookie },
      payload: { statusId: done.id, assigneeId: target.id },
    });
    const events = (await notificationsOf(third.id, "ticket.activity"))
      .filter((x) => x.ticketId === ticketId)
      .map((x) => x.event as { change: string; summary: string });
    expect(events.map((e) => [e.change, e.summary]).sort()).toEqual([
      ["assignee", "decide"],
      ["status", "Done"],
    ]);
  });

  it("la pipeline che porta a in_review non notifica i follower", async () => {
    const ticketId = await task();
    await testDb.db.insert(ticketFollowers).values({ ticketId, userId: third.id });
    const { recordTicketStatusChange } = await import("@stubwise/db");
    await testDb.db.update(tickets).set({ status: "in_review" }).where(eq(tickets.id, ticketId));
    await recordTicketStatusChange(testDb.db, { ticketId, from: "open", to: "in_review", actorId: null });
    expect((await notificationsOf(third.id, "ticket.activity")).filter((x) => x.ticketId === ticketId)).toHaveLength(0);
  });
});
