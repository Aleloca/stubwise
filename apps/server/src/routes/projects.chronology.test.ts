import { randomBytes } from "node:crypto";
import { milestones, projectBriefs, projectDecisions, tickets } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { chronologyPageSchema, weeklyBriefViewSchema } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers, type SeededUsers } from "../test/fixtures.js";

/**
 * La cronologia dell'Overview e l'attività del portafoglio (integrazione area
 * 2, fetta 4): i kind del prototipo, a pagine di 28 giorni all'indietro
 * (`before` escluso, l'inizio della pagina incluso: un evento al bordo sta in
 * UNA pagina sola), i traguardi futuri nella prima pagina; e il brief
 * settimanale come lo mostra l'Overview.
 */

const SESSION_SECRET = "segreto-di-test-lungo-almeno-32-caratteri!!";
const DAY = 86_400_000;

let testDb: TestDb;
let app: FastifyInstance;
let users: SeededUsers;
let projectId: string;
let otherProjectId: string;
let hiddenProjectId: string;
let member: { id: string; headers: { cookie: string } };
let n = 0;

beforeAll(async () => {
  testDb = await startTestDb();
  app = buildApp({ db: testDb.db, sessionSecret: SESSION_SECRET, encryptionKey: randomBytes(32).toString("base64") });
  users = await seedUsers(app);
  ({ projectId } = await seedRepository(testDb.db));
  ({ projectId: otherProjectId } = await seedRepository(testDb.db));
  ({ projectId: hiddenProjectId } = await seedRepository(testDb.db));
  member = await createUserWithSession(app, "membro@example.com");
  await addMember(app, projectId, member.id, "developer");
  await addMember(app, otherProjectId, member.id, "developer");
}, 120_000);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

async function ticketAt(pid: string, at: Date): Promise<string> {
  n += 1;
  const [row] = await testDb.db
    .insert(tickets)
    .values({ projectId: pid, number: n, title: `T${n}`, type: "bug", priority: "medium", source: "manual", createdAt: at })
    .returning({ id: tickets.id });
  return row!.id;
}

const page = async (url: string, cookie = users.adminCookie) => {
  const res = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return chronologyPageSchema.parse(res.json());
};

describe("GET /api/projects/:projectId/chronology", () => {
  it("prima pagina: le ultime 4 settimane coi kind del prototipo, più i traguardi futuri; nextBefore se c'è storia prima", async () => {
    const now = Date.now();
    const recent = await ticketAt(projectId, new Date(now - 3 * DAY));
    const old = await ticketAt(projectId, new Date(now - 40 * DAY));
    const [future] = await testDb.db
      .insert(milestones)
      .values({ projectId, name: "Lancio", dueDate: new Date(now + 60 * DAY) })
      .returning({ id: milestones.id });
    const [d] = await testDb.db
      .insert(projectDecisions)
      .values({
        projectId,
        source: "manual",
        sourceKey: `manual:${n}`,
        title: "Usiamo Postgres",
        decision: "Sì",
        decidedAt: new Date(now - 2 * DAY),
      })
      .returning({ id: projectDecisions.id });
    const first = await page(`/api/projects/${projectId}/chronology`);
    expect(first.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "task_opened", taskId: recent }),
        expect.objectContaining({ kind: "milestone", milestoneId: future!.id }),
        expect.objectContaining({ kind: "decision", decisionId: d!.id, title: "Usiamo Postgres" }),
      ]),
    );
    expect(first.events.some((e) => e.taskId === old)).toBe(false);
    // Dalla più recente: il traguardo futuro sta in cima.
    expect(first.events[0]).toMatchObject({ kind: "milestone", milestoneId: future!.id });
    expect(first.nextBefore).not.toBeNull();
    const older = await page(`/api/projects/${projectId}/chronology?before=${encodeURIComponent(first.nextBefore!)}`);
    expect(older.events.map((e) => e.taskId)).toContain(old);
    // Nelle pagine vecchie niente traguardi futuri.
    expect(older.events.some((e) => e.kind === "milestone")).toBe(false);
  });

  it("al bordo della finestra: un evento esattamente a 28 giorni da `before` sta in una pagina sola", async () => {
    const { projectId: pid } = await seedRepository(testDb.db);
    const before = new Date("2030-03-01T00:00:00.000Z");
    const edge = new Date(before.getTime() - 28 * DAY);
    const atBefore = await ticketAt(pid, before);
    const atEdge = await ticketAt(pid, edge);
    const p1 = await page(`/api/projects/${pid}/chronology?before=${before.toISOString()}`);
    const p0 = await page(`/api/projects/${pid}/chronology?before=${new Date(before.getTime() + 28 * DAY).toISOString()}`);
    const p2 = await page(`/api/projects/${pid}/chronology?before=${edge.toISOString()}`);
    const ids = (p: { events: { taskId?: string }[] }) => p.events.map((e) => e.taskId);
    // L'inizio della pagina è incluso, `before` no.
    expect(ids(p1)).toContain(atEdge);
    expect(ids(p2)).not.toContain(atEdge);
    expect(ids(p1)).not.toContain(atBefore);
    expect(ids(p0)).toContain(atBefore);
    expect(p1.nextBefore).toBe(edge.toISOString());
  });

  it("un progetto invisibile → 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${hiddenProjectId}/chronology`,
      headers: { cookie: member.headers.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/activity/portfolio", () => {
  it("l'attività dei progetti visibili, col progetto accanto; né i progetti invisibili né i traguardi futuri", async () => {
    const now = Date.now();
    const a = await ticketAt(projectId, new Date(now - DAY));
    const b = await ticketAt(otherProjectId, new Date(now - 2 * DAY));
    const hidden = await ticketAt(hiddenProjectId, new Date(now - DAY));
    await testDb.db.insert(milestones).values({ projectId: otherProjectId, name: "Futuro", dueDate: new Date(now + 10 * DAY) });
    const res = await page("/api/activity/portfolio", member.headers.cookie);
    expect(res.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "task_opened", taskId: a, projectId }),
        expect.objectContaining({ kind: "task_opened", taskId: b, projectId: otherProjectId }),
      ]),
    );
    expect(res.events.some((e) => e.taskId === hidden)).toBe(false);
    expect(res.events.some((e) => e.kind === "milestone" && Date.parse(e.at) > now)).toBe(false);
    // Dalla più recente.
    const ats = res.events.map((e) => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });
});

describe("GET /api/projects/:projectId/briefs/latest", () => {
  it("il brief più recente come lo mostra l'Overview, etichettato come testo generato; null se non ce n'è", async () => {
    const { projectId: pid } = await seedRepository(testDb.db);
    const latest = (cookie = users.adminCookie) =>
      app.inject({ method: "GET", url: `/api/projects/${pid}/briefs/latest`, headers: { cookie } });
    const none = await latest();
    expect(none.statusCode).toBe(200);
    expect(none.json()).toBeNull();
    await testDb.db.insert(projectBriefs).values([
      { projectId: pid, periodStart: "2026-10-26", periodEnd: "2026-11-01", status: "done", summary: "vecchio", createdAt: new Date("2026-11-02T08:00:00Z") },
      {
        projectId: pid,
        periodStart: "2026-11-02",
        periodEnd: "2026-11-08",
        status: "done",
        summary: "## Dove siamo\nA buon punto.\n\n## Cosa è cambiato\nIl login.",
        sections: { whereWeAre: "A buon punto.", whatChanged: "Il login." },
        createdAt: new Date("2026-11-09T08:00:00Z"),
      },
      { projectId: pid, periodStart: "2026-11-09", periodEnd: "2026-11-15", status: "running", createdAt: new Date("2026-11-16T08:00:00Z") },
    ]);
    const res = await latest();
    expect(res.statusCode, res.body).toBe(200);
    expect(weeklyBriefViewSchema.parse(res.json())).toMatchObject({
      periodStart: "2026-11-02",
      periodEnd: "2026-11-08",
      headline: "A buon punto.",
      summary: "## Dove siamo\nA buon punto.\n\n## Cosa è cambiato\nIl login.",
      generated: true,
    });
  });
});
