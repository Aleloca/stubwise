import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { milestones, projects, tickets } from "@stubwise/db";
import { eq } from "drizzle-orm";
import { seedBacklogItem, seedRepository, startTestDb, type TestDb, roleInsert } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, seedUsers, type SeededUsers } from "../test/fixtures.js";

// Lotto 7, voce 4: `GET /api/projects/pulses`, il polso della nuova app dal server.

let t: TestDb;
let app: FastifyInstance;
let users: SeededUsers;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

type Pulse = { projectId: string; open: { todo: number; active: number }; stalled: number; waitingOnMe: boolean; nextMilestone: { name: string } | null; waiting: Record<string, number>; truncated: boolean };
const pulses = async (query = "") => {
  const res = await app.inject({ method: "GET", url: `/api/projects/pulses${query}`, headers: { cookie: users.memberCookie } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: Pulse[] }).items;
};
let n = 0;
const insertTasks = (projectId: string, status: "open" | "in_progress" | "done", count = 1) =>
  t.db.insert(tickets).values(Array.from({ length: count }, () => ({ projectId, number: ++n, title: `T${n}`, type: "task" as const, priority: "medium" as const, ...roleInsert(projectId, status), source: "manual" as const })));

describe("GET /api/projects/pulses (lotto 7, voce 4)", () => {
  it("le aperte per famiglia, il traguardo aperto più vicino, le richieste da trasformare; solo i progetti che chi guarda vede", async () => {
    const { projectId } = await seedRepository(t.db);
    const { projectId: hidden } = await seedRepository(t.db);
    await addMember(app, projectId, users.memberId, "project_lead");
    await insertTasks(projectId, "open", 2);
    await insertTasks(projectId, "in_progress");
    await insertTasks(projectId, "done");
    await t.db.insert(milestones).values([
      { projectId, name: "Lontano", dueDate: new Date("2027-06-01T00:00:00Z") },
      { projectId, name: "Vicino", dueDate: new Date("2026-12-01T00:00:00Z") },
      { projectId, name: "Chiuso", dueDate: new Date("2026-01-01T00:00:00Z"), status: "closed", closedAt: new Date() },
    ]);
    // Le richieste da trasformare contano solo col backlog acceso (la regola della loro rotta).
    await t.db.update(projects).set({ backlogEnabled: true }).where(eq(projects.id, projectId));
    await seedBacklogItem(t.db, { projectId, title: "Da trasformare", status: "new" });

    const [p, ...rest] = await pulses();
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ projectId, open: { todo: 2, active: 1 }, nextMilestone: { name: "Vicino" }, waitingOnMe: true, truncated: false });
    expect(p!.waiting).toMatchObject({ requestsToConvert: 1, decisionsForMe: 0 });
    // Un id invisibile chiesto esplicitamente non compare.
    expect(await pulses(`?projectIds=${hidden}`)).toEqual([]);
    expect((await pulses(`?projectIds=${hidden},${projectId}`)).map((x) => x.projectId)).toEqual([projectId]);
  });

  it("revisione I-1: 3000 task si CONTANO esatte, senza tetto né «+»; le decisioni rivolte a chi guarda si contano", async () => {
    const { projectId } = await seedRepository(t.db);
    await addMember(app, projectId, users.memberId, "project_lead");
    await insertTasks(projectId, "open", 2600);
    await insertTasks(projectId, "in_progress", 400);
    const [first] = await t.db.select({ id: tickets.id }).from(tickets).where(eq(tickets.projectId, projectId)).limit(1);
    const asked = await app.inject({ method: "POST", url: `/api/tasks/${first!.id}/decisions`, headers: { cookie: users.adminCookie }, payload: { askedOfId: users.memberId, question: "Quale?" } });
    expect(asked.statusCode, asked.body).toBeLessThan(300);
    // Una rivolta a un altro non conta per chi guarda.
    const other = await app.inject({ method: "POST", url: `/api/tasks/${first!.id}/decisions`, headers: { cookie: users.memberCookie }, payload: { askedOfId: users.adminId, question: "E tu?" } });
    expect(other.statusCode, other.body).toBeLessThan(300);
    // Una ferma a mano: la conta la regola di `stallsOf`, dalla forma ridotta.
    await t.db.update(tickets).set({ manualStallReason: "waiting_external", manualStallSince: new Date() }).where(eq(tickets.id, first!.id));
    const [p] = await pulses(`?projectIds=${projectId}`);
    // Ferme: le 400 attive senza assegnatario (`unassigned`, la regola di `stallOf`) più quella ferma a mano.
    expect(p).toMatchObject({ open: { todo: 2600, active: 400 }, stalled: 401, truncated: false });
    expect(p!.waiting.decisionsForMe).toBe(1);
  }, 120_000);
});
