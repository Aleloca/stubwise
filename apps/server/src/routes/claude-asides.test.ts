import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agentSessionEvents, issueChatToolToken, projects, projectStatuses, tickets } from "@stubwise/db";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * Area 10, F3 (S2): l'evento `aside` del lavoro fermo si arricchisce a lettura
 * con la visibilità di CHI GUARDA: in una pubblica il lettore che non è membro
 * di un progetto non ne vede la riga, e l'ipotesi di quella riga sparisce.
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
type U = Awaited<ReturnType<typeof createUserWithSession>>;
let author: U;
let reader: U;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40) });
  await seedUsers(app);
  author = await createUserWithSession(app, "author-aside@example.com");
  reader = await createUserWithSession(app, "reader-aside@example.com");
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

const codeOf = async (projectId: string) => (await t.db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId)))[0]!.code;
const events = async (sid: string, who: U) =>
  ((await app.inject({ method: "GET", url: `/api/agent-sessions/${sid}/events`, headers: { cookie: who.headers.cookie } })).json() as { events: { type: string; data: Record<string, unknown> }[] }).events.filter((e) => e.type === "aside");

describe("l'aside del lavoro fermo, a lettura", () => {
  it("l'autore vede le righe coi codici; il lettore di una pubblica solo quelle dei progetti che vede, e l'ipotesi di una riga sparita non c'è", async () => {
    const shared = await seedTicket(t.db, { number: 12 });
    const hidden = await seedTicket(t.db, { number: 7 });
    for (const u of [author, reader]) await addMember(app, shared.projectId, u.id, "developer");
    await addMember(app, hidden.projectId, author.id, "developer");
    await t.db.update(tickets).set({ status: "done" }).where(eq(tickets.id, shared.ticketId));
    const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: author.headers.cookie }, payload: {} });
    const sid = (res.json() as { id: string }).id;
    await t.db.insert(agentSessionEvents).values({
      sessionId: sid,
      segmentId: "stubwise-claude-actions",
      type: "aside",
      data: {
        rows: [
          { projectId: hidden.projectId, count: 3, oldest: { ticketId: hidden.ticketId, stalledSince: "2026-11-01T00:00:00.000Z", reason: "unassigned" } },
          { projectId: shared.projectId, count: 1, oldest: { ticketId: shared.ticketId, stalledSince: "2026-11-05T00:00:00.000Z", reason: "manual" } },
        ],
        hypothesis: { ticketId: hidden.ticketId, key: "out_of_plan" },
      },
    });
    const sharedCode = await codeOf(shared.projectId);
    const hiddenCode = await codeOf(hidden.projectId);
    const [mine] = await events(sid, author);
    expect(mine!.data).toEqual({
      rows: [
        { projectId: hidden.projectId, projectCode: hiddenCode, count: 3, ticketId: hidden.ticketId, taskCode: `${hiddenCode}-7`, stalledSince: "2026-11-01T00:00:00.000Z", reason: "unassigned", closed: false, thresholdDays: null },
        { projectId: shared.projectId, projectCode: sharedCode, count: 1, ticketId: shared.ticketId, taskCode: `${sharedCode}-12`, stalledSince: "2026-11-05T00:00:00.000Z", reason: "manual", closed: true, thresholdDays: null },
      ],
      hypothesis: { ticketId: hidden.ticketId, taskCode: `${hiddenCode}-7`, key: "out_of_plan" },
    });
    // La pubblica: l'autore conferma i progetti letti (qui nessuno registrato).
    const pub = await app.inject({ method: "POST", url: `/api/claude/conversations/${sid}/visibility`, headers: { cookie: author.headers.cookie }, payload: { visibility: "public", confirmedProjectIds: [] } });
    expect(pub.statusCode).toBe(200);
    const [theirs] = await events(sid, reader);
    expect(theirs!.data).toEqual({
      rows: [{ projectId: shared.projectId, projectCode: sharedCode, count: 1, ticketId: shared.ticketId, taskCode: `${sharedCode}-12`, stalledSince: "2026-11-05T00:00:00.000Z", reason: "manual", closed: true, thresholdDays: null }],
      hypothesis: null,
    });
    expect(JSON.stringify(theirs)).not.toContain(hidden.projectId);
  });

  it("le SOGLIE DEI PROGETTI (la regola della lista delle task): oltre la soglia è ferma, dentro no, con gli stessi dati della lista; l'aside porta la soglia", async () => {
    const { projectId } = await seedRepository(t.db);
    await addMember(app, projectId, author.id, "project_lead");
    await t.db.update(projects).set({ stallActiveDays: 5 }).where(eq(projects.id, projectId));
    const [active] = await t.db.select({ id: projectStatuses.id }).from(projectStatuses).where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.family, "active"))).limit(1);
    const mk = async (number: number, daysAgo: number) => {
      const [row] = await t.db.insert(tickets).values({ projectId, number, title: `T${number}`, type: "bug", priority: "medium", source: "manual", assigneeId: author.id, statusId: active!.id }).returning();
      await t.db.update(tickets).set({ updatedAt: sql`now() - make_interval(days => ${daysAgo}::int)` }).where(eq(tickets.id, row!.id));
      return row!.id;
    };
    const beyond = await mk(41, 8);
    const inside = await mk(42, 3);
    const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: author.headers.cookie }, payload: {} });
    const sid = (res.json() as { id: string }).id;
    const token = await issueChatToolToken(t.db, { sessionId: sid, userId: author.id, ttlMs: 60_000 });
    const viaToken = (await app.inject({ method: "GET", url: `/api/tasks/stalled?projectIds=${projectId}`, headers: { authorization: `Bearer ${token}` } })).json() as { task: { id: string }; stall: { reason: { kind: string } } }[];
    const viaList = (await app.inject({ method: "GET", url: `/api/tasks/stalled?projectIds=${projectId}`, headers: { cookie: author.headers.cookie } })).json() as unknown[];
    expect(viaToken).toEqual(viaList);
    expect(viaToken.map((r) => r.task.id)).toContain(beyond);
    expect(viaToken.map((r) => r.task.id)).not.toContain(inside);
    await t.db.insert(agentSessionEvents).values({
      sessionId: sid,
      segmentId: "stubwise-claude-actions",
      type: "aside",
      data: { rows: [{ projectId, count: 1, oldest: { ticketId: beyond, stalledSince: "2026-11-12T00:00:00.000Z", reason: "idle" } }], hypothesis: null },
    });
    const [mine] = await events(sid, author);
    expect((mine!.data as { rows: { thresholdDays: number | null }[] }).rows[0]!.thresholdDays).toBe(5);
  });
});
