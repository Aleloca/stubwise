import { randomBytes } from "node:crypto";
import { projectStatuses, projects, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, seedTicket, startTestDb } from "@stubwise/db/testing";
import { projectStatusViewSchema } from "@stubwise/shared";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, seedUsers, type SeededUsers } from "../test/fixtures.js";

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({
    db: testDb.db,
    sessionSecret: SESSION_SECRET,
    encryptionKey: randomBytes(32).toString("base64"),
  });
  users = await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

/** Un progetto in cui il member è Project Lead (ha project.settings.manage). */
const repoOf = new Map<string, string>();
async function leadProject(): Promise<string> {
  const { projectId, repositoryId } = await seedRepository(testDb.db);
  repoOf.set(projectId, repositoryId);
  await addMember(app, projectId, users.memberId, "project_lead");
  return projectId;
}

const rows = (projectId: string) =>
  testDb.db
    .select({
      id: projectStatuses.id,
      name: projectStatuses.name,
      family: projectStatuses.family,
      legacy: projectStatuses.legacyStatus,
    })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(asc(projectStatuses.position));

const put = (projectId: string, payload: unknown, cookie = users.memberCookie) =>
  app.inject({
    method: "PUT",
    url: `/api/projects/${projectId}/statuses`,
    headers: { cookie },
    payload: payload as object,
  });

describe("stati del progetto", () => {
  it("GET li restituisce in ordine, nella forma condivisa", async () => {
    const projectId = await leadProject();
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/statuses`,
      headers: { cookie: users.memberCookie },
    });
    expect(res.statusCode).toBe(200);
    const list = projectStatusViewSchema.array().parse(res.json());
    expect(list.map((s) => s.name)).toEqual(["To do", "In progress", "In review", "Done", "Discarded"]);
  });

  it("un progetto invisibile → 404", async () => {
    const { projectId } = await seedRepository(testDb.db);
    const get = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/statuses`,
      headers: { cookie: users.memberCookie },
    });
    expect(get.statusCode).toBe(404);
    // Un body valido: la validazione gira prima dell'accesso (un 400 di formato non rivela nulla).
    const body = {
      statuses: [
        { name: "a", family: "todo" },
        { name: "b", family: "active" },
        { name: "c", family: "closed" },
      ],
      reassign: {},
    };
    expect((await put(projectId, body)).statusCode).toBe(404);
  });

  it("un Developer → 403 e stati invariati", async () => {
    const { projectId } = await seedRepository(testDb.db);
    await addMember(app, projectId, users.memberId, "developer");
    const before = await rows(projectId);
    const res = await put(projectId, {
      statuses: before.map((s) => ({ id: s.id, name: `${s.name}!`, family: s.family })),
      reassign: {},
    });
    expect(res.statusCode).toBe(403);
    expect(await rows(projectId)).toEqual(before);
  });

  it("PUT senza uno stato closed è rifiutato, e gli stati restano", async () => {
    const projectId = await leadProject();
    const before = await rows(projectId);
    const res = await put(projectId, {
      statuses: before.filter((s) => s.family !== "closed").map((s) => ({ id: s.id, name: s.name, family: s.family })),
      reassign: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "status_family_missing" });
    expect(await rows(projectId)).toEqual(before);
  });

  it("eliminare uno stato con task senza reassign è rifiutato; con reassign le task si spostano", async () => {
    const projectId = await leadProject();
    const { ticketId } = await seedTicket(testDb.db, { projectId, repositoryId: repoOf.get(projectId)! });
    const before = await rows(projectId);
    const toDo = before[0]!;
    const inProgress = before[1]!;
    await testDb.db.update(tickets).set({ statusId: inProgress.id }).where(eq(tickets.id, ticketId));
    const without = before.filter((s) => s.id !== inProgress.id).map((s) => ({ id: s.id, name: s.name, family: s.family }));
    const bad = await put(projectId, { statuses: without, reassign: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "status_reassign_missing" });
    expect(await rows(projectId)).toEqual(before);
    const ok = await put(projectId, { statuses: without, reassign: { [inProgress.id]: before[2]!.id } });
    expect(ok.statusCode).toBe(200);
    const [t] = await testDb.db.select({ s: tickets.statusId, e: tickets.status }).from(tickets).where(eq(tickets.id, ticketId));
    expect(t).toEqual({ s: before[2]!.id, e: "in_progress" });
    expect((await rows(projectId)).map((s) => s.name)).toEqual(["To do", "In review", "Done", "Discarded"]);
    expect(toDo.id).toBe((await rows(projectId))[0]!.id);
  });

  it("rinomina e riordina ricalcolano legacy_status", async () => {
    const projectId = await leadProject();
    const [toDo, inProgress, inReview, done, discarded] = await rows(projectId);
    const res = await put(projectId, {
      statuses: [
        { id: toDo!.id, name: "Backlog", family: "todo" },
        { name: "Ready", family: "todo" },
        { id: inReview!.id, name: "Review", family: "active" },
        { id: inProgress!.id, name: "Doing", family: "active" },
        { id: discarded!.id, name: "Won't do", family: "closed" },
        { id: done!.id, name: "Shipped", family: "closed" },
      ],
      reassign: {},
    });
    expect(res.statusCode).toBe(200);
    expect(projectStatusViewSchema.array().parse(res.json()).map((s) => s.name)).toEqual([
      "Backlog",
      "Ready",
      "Review",
      "Doing",
      "Won't do",
      "Shipped",
    ]);
    expect((await rows(projectId)).map((s) => [s.name, s.legacy])).toEqual([
      ["Backlog", "open"],
      ["Ready", "open"],
      ["Review", "in_progress"],
      ["Doing", "in_review"],
      ["Won't do", "done"],
      ["Shipped", "closed"],
    ]);
  });

  it("uno stato di un altro progetto nel body → 400 e nulla cambia", async () => {
    const projectId = await leadProject();
    const other = await leadProject();
    const before = await rows(projectId);
    const foreign = (await rows(other))[0]!;
    const res = await put(projectId, {
      statuses: [...before.map((s) => ({ id: s.id, name: s.name, family: s.family })), { id: foreign.id, name: "x", family: "todo" }],
      reassign: {},
    });
    expect(res.statusCode).toBe(400);
    expect(await rows(projectId)).toEqual(before);
  });
});

describe("soglie «ferma»", () => {
  it("si impostano fra 1 e 90, e un Developer non può", async () => {
    const projectId = await leadProject();
    const ok = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/stall-thresholds`,
      headers: { cookie: users.memberCookie },
      payload: { activeDays: 3, todoDays: 30 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ activeDays: 3, todoDays: 30 });
    const bad = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/stall-thresholds`,
      headers: { cookie: users.memberCookie },
      payload: { activeDays: 0, todoDays: 30 },
    });
    expect(bad.statusCode).toBe(400);
    await addMember(app, projectId, users.memberId, "developer");
    const dev = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/stall-thresholds`,
      headers: { cookie: users.memberCookie },
      payload: { activeDays: 9, todoDays: 9 },
    });
    expect(dev.statusCode).toBe(403);
    const [p] = await testDb.db
      .select({ a: projects.stallActiveDays, t: projects.stallTodoDays })
      .from(projects)
      .where(eq(projects.id, projectId));
    expect(p).toEqual({ a: 3, t: 30 });
  });
});

describe("codici di progetto", () => {
  it("un progetto nuovo ha un codice, e la risposta lo porta", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: users.adminCookie },
      payload: { name: "Audin AI" },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { code: string }).code).toMatch(/^AUD\d*$/);
  });

  it("PATCH code già usato → 409 code_taken; un codice libero si salva", async () => {
    const a = await leadProject();
    const b = await leadProject();
    const [pa] = await testDb.db.select({ code: projects.code }).from(projects).where(eq(projects.id, a));
    const taken = await app.inject({
      method: "PATCH",
      url: `/api/projects/${b}`,
      headers: { cookie: users.memberCookie },
      payload: { code: pa!.code },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: "code_taken" });
    const ok = await app.inject({
      method: "PATCH",
      url: `/api/projects/${b}`,
      headers: { cookie: users.memberCookie },
      payload: { code: "ZZ9" },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { code: string }).code).toBe("ZZ9");
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/projects/${b}`,
      headers: { cookie: users.memberCookie },
      payload: { code: "zz" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
