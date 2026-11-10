import { randomBytes } from "node:crypto";
import {
  backlogItemRequesters,
  backlogItems,
  comments,
  commitSummaries,
  decisionRequests,
  departmentMembers,
  projectDecisions,
  projectStatuses,
  projects,
  roles,
  ticketEvents,
  tickets,
  users,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedDepartment, seedRepository, startTestDb } from "@stubwise/db/testing";
import { personDayActivitySchema, type PersonDayActivityView } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * L'attività del giorno per persona (integrazione area 3, fetta 3d; decisione
 * del maintainer: aggregata sul server, permesso `people.activity.view` che
 * nessun preset riceve tranne il full admin). Il giorno è nel fuso
 * Europe/Rome; entrano solo i fatti dei progetti che chi guarda vede.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const DAY = "2026-11-09";
/** Le 23:30 dell'8 a Roma: il giorno prima, anche se in UTC è il 9 meno mezz'ora… */
const BEFORE_DAY = new Date("2026-11-08T22:30:00Z");
/** Le 00:30 del 9 a Roma (in UTC è ancora l'8): conta per il 9. */
const EARLY = new Date("2026-11-08T23:30:00Z");
const NOON = new Date("2026-11-09T11:00:00Z");

let testDb: TestDb;
let app: FastifyInstance;
let users_: SeededUsers;
let projectId: string;
let repositoryId: string;
let hiddenProjectId: string;
let hiddenRepositoryId: string;
let code: string;
let lead: { id: string; headers: { cookie: string } };
let anna: { id: string; headers: { cookie: string } };
let deptId: string;
let taskId: string;
let n = 0;

async function task(pid: string, over: Partial<typeof tickets.$inferInsert> = {}) {
  n += 1;
  const [row] = await testDb.db
    .insert(tickets)
    .values({ projectId: pid, number: 5000 + n, title: `Task ${n}`, type: "bug", priority: "medium", source: "manual", ...over })
    .returning({ id: tickets.id, number: tickets.number });
  return row!;
}

async function statusOf(pid: string, family: "todo" | "active" | "closed") {
  const [s] = await testDb.db
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, pid), eq(projectStatuses.family, family)));
  return s!.id;
}

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  users_ = await seedUsers(app);
  ({ projectId, repositoryId } = await seedRepository(testDb.db));
  ({ projectId: hiddenProjectId, repositoryId: hiddenRepositoryId } = await seedRepository(testDb.db));
  [{ code }] = (await testDb.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId))) as [{ code: string }];
  lead = await createUserWithSession(app, "lead-a@example.com");
  anna = await createUserWithSession(app, "anna@example.com");
  await addMember(app, projectId, lead.id, "project_lead");
  await addMember(app, projectId, anna.id, "developer");
  await addMember(app, hiddenProjectId, anna.id, "developer");
  ({ id: deptId } = await seedDepartment(testDb.db, { name: "Prodotto" }));
  await testDb.db.insert(departmentMembers).values({ departmentId: deptId, userId: anna.id });

  // Una task che Anna chiude (assegnataria) e sposta, alle 00:30 di Roma.
  const t = await task(projectId, { assigneeId: anna.id });
  taskId = t.id;
  const [todo, active, closed] = [await statusOf(projectId, "todo"), await statusOf(projectId, "active"), await statusOf(projectId, "closed")];
  await testDb.db.insert(ticketEvents).values([
    { ticketId: taskId, actorId: anna.id, kind: "status_changed", payload: { from: "open", to: "in_progress", fromStatusId: todo, toStatusId: active }, createdAt: EARLY },
    { ticketId: taskId, actorId: anna.id, kind: "status_changed", payload: { from: "in_progress", to: "done", fromStatusId: active, toStatusId: closed }, createdAt: NOON },
    // Il giorno prima, a Roma: fuori.
    { ticketId: taskId, actorId: anna.id, kind: "status_changed", payload: { from: "open", to: "open" }, createdAt: BEFORE_DAY },
  ]);
  await testDb.db.insert(comments).values([
    { ticketId: taskId, authorType: "user", authorId: anna.id, body: "Fatto", createdAt: NOON },
    { ticketId: taskId, authorType: "user", authorId: anna.id, body: "", createdAt: NOON, deletedAt: NOON },
  ]);
  await testDb.db.insert(projectDecisions).values({
    projectId,
    source: "manual",
    sourceKey: `manual:a-${n}`,
    ticketId: taskId,
    title: "Usiamo Postgres",
    decision: "Sì",
    decidedByUserId: anna.id,
    decidedAt: NOON,
  });
  await testDb.db.insert(decisionRequests).values({
    ticketId: taskId,
    askedByUserId: lead.id,
    askedOfUserId: anna.id,
    question: "Va bene venerdì?",
    options: ["Sì", "No"],
    answerOptionIndex: 0,
    answeredAt: NOON,
    answeredByUserId: anna.id,
  });
  const [item] = await testDb.db
    .insert(backlogItems)
    .values({ projectId, title: "Esportare", source: "manual", createdAt: NOON })
    .returning({ id: backlogItems.id, number: backlogItems.number });
  await testDb.db.insert(backlogItemRequesters).values({ itemId: item!.id, userId: anna.id, requestedAt: NOON });
  await testDb.db.insert(commitSummaries).values([
    { repositoryId, sha: "a1", committedAt: NOON, authorName: "Anna", authorEmail: "anna@example.com", subject: "fix login", summary: "Corregge il login" },
    { repositoryId, sha: "b2", committedAt: NOON, authorName: "Esterno", authorEmail: "ext@example.org", subject: "docs", summary: "Docs" },
  ]);

  // Lo stesso tipo di fatti in un progetto che il lead NON vede.
  const hidden = await task(hiddenProjectId, { assigneeId: anna.id, title: "SEGRETA" });
  await testDb.db.insert(comments).values({ ticketId: hidden.id, authorType: "user", authorId: anna.id, body: "SEGRETO", createdAt: NOON });
  await testDb.db.insert(commitSummaries).values({
    repositoryId: hiddenRepositoryId,
    sha: "c3",
    committedAt: NOON,
    authorName: "Anna",
    authorEmail: "anna@example.com",
    subject: "SEGRETO",
    summary: "SEGRETO",
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });

/** Il lead col permesso dato da un ruolo d'istanza (nessun preset lo ha). Direttamente sul DB: le rotte dei ruoli chiedono la riconferma. */
async function grantActivity(userId: string) {
  const [role] = await testDb.db
    .insert(roles)
    .values({ name: `Standup ${n}`, scope: "instance", permissions: ["users.view_all", "people.activity.view"] })
    .returning({ id: roles.id });
  await testDb.db.update(users).set({ instanceRoleId: role!.id }).where(eq(users.id, userId));
}

describe("GET /api/people/activity", () => {
  it("senza people.activity.view → 403 (nessun preset lo dà, nemmeno Project Lead)", async () => {
    expect((await get(`/api/people/activity?date=${DAY}`, lead.headers.cookie)).statusCode).toBe(403);
  });

  it("per persona, nel giorno di Roma: task chiuse e spostate, commenti, decisioni, richieste, commit; mai i progetti invisibili", async () => {
    await grantActivity(lead.id);
    const res = await get(`/api/people/activity?date=${DAY}`, lead.headers.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain("SEGRET");
    const rows = z.array(personDayActivitySchema).parse(res.json());
    const annaRow = rows.find((r) => r.personId === anna.id) as PersonDayActivityView;
    expect(annaRow.name).toBe("anna");
    // Il suo reparto (più quello di default, che ogni persona ha).
    expect(annaRow.departmentIds).toContain(deptId);
    expect(annaRow.tasksClosed).toEqual([expect.objectContaining({ taskId, code: expect.stringMatching(new RegExp(`^${code}-`)) })]);
    expect(annaRow.tasksMoved).toHaveLength(2);
    expect(annaRow.tasksMoved[0]).toMatchObject({ field: "status", viaClaude: false });
    expect(annaRow.comments.map((c) => c.body)).toEqual(["Fatto"]);
    expect(annaRow.decisions.map((d) => [d.source, d.title]).sort()).toEqual([
      ["answer", "Va bene venerdì?"],
      ["log", "Usiamo Postgres"],
    ]);
    expect(annaRow.requestsCreated).toEqual([expect.objectContaining({ code: expect.stringMatching(new RegExp(`^${code}-R`)), title: "Esportare" })]);
    expect(annaRow.commits.map((c) => c.sha)).toEqual(["a1"]);
    // Un autore di commit non collegato a nessuna persona: riga a sé, senza persona.
    expect(rows.find((r) => r.personId === null)).toMatchObject({ name: "Esterno", commits: [expect.objectContaining({ sha: "b2" })] });
  });

  it("il giorno prima (a Roma) non c'entra; un giorno senza fatti → []", async () => {
    const res = await get(`/api/people/activity?date=2026-11-08`, lead.headers.cookie);
    const rows = z.array(personDayActivitySchema).parse(res.json());
    // L'unico fatto dell'8 a Roma è lo status_changed delle 23:30.
    expect(rows.flatMap((r) => r.comments)).toEqual([]);
    expect((z.array(personDayActivitySchema).parse((await get(`/api/people/activity?date=2026-01-01`, lead.headers.cookie)).json()))).toEqual([]);
  });

  it("con departmentId: solo le persone del reparto (gli autori non collegati no)", async () => {
    const rows = z
      .array(personDayActivitySchema)
      .parse((await get(`/api/people/activity?date=${DAY}&departmentId=${deptId}`, lead.headers.cookie)).json());
    expect(rows.map((r) => r.personId)).toEqual([anna.id]);
  });

  it("una data non valida → 400", async () => {
    expect((await get(`/api/people/activity?date=9-11-2026`, users_.adminCookie)).statusCode).toBe(400);
  });

  it("i nomi: non la mail intera", async () => {
    const [u] = await testDb.db.select({ email: users.email }).from(users).where(eq(users.id, anna.id));
    expect(u!.email).toBe("anna@example.com");
  });
});
