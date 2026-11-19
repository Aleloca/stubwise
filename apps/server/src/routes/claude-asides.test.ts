import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentSessionEvents, projects, tickets } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
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
          { projectId: hidden.projectId, count: 3, oldest: { ticketId: hidden.ticketId, stalledSince: "2026-11-01T00:00:00.000Z", reason: "to_prepare" } },
          { projectId: shared.projectId, count: 1, oldest: { ticketId: shared.ticketId, stalledSince: "2026-11-05T00:00:00.000Z", reason: "interrupted" } },
        ],
        hypothesis: { ticketId: hidden.ticketId, key: "out_of_plan" },
      },
    });
    const sharedCode = await codeOf(shared.projectId);
    const hiddenCode = await codeOf(hidden.projectId);
    const [mine] = await events(sid, author);
    expect(mine!.data).toEqual({
      rows: [
        { projectId: hidden.projectId, projectCode: hiddenCode, count: 3, ticketId: hidden.ticketId, taskCode: `${hiddenCode}-7`, stalledSince: "2026-11-01T00:00:00.000Z", reason: "to_prepare", closed: false },
        { projectId: shared.projectId, projectCode: sharedCode, count: 1, ticketId: shared.ticketId, taskCode: `${sharedCode}-12`, stalledSince: "2026-11-05T00:00:00.000Z", reason: "interrupted", closed: true },
      ],
      hypothesis: { ticketId: hidden.ticketId, taskCode: `${hiddenCode}-7`, key: "out_of_plan" },
    });
    // La pubblica: l'autore conferma i progetti letti (qui nessuno registrato).
    const pub = await app.inject({ method: "POST", url: `/api/claude/conversations/${sid}/visibility`, headers: { cookie: author.headers.cookie }, payload: { visibility: "public", confirmedProjectIds: [] } });
    expect(pub.statusCode).toBe(200);
    const [theirs] = await events(sid, reader);
    expect(theirs!.data).toEqual({
      rows: [{ projectId: shared.projectId, projectCode: sharedCode, count: 1, ticketId: shared.ticketId, taskCode: `${sharedCode}-12`, stalledSince: "2026-11-05T00:00:00.000Z", reason: "interrupted", closed: true }],
      hypothesis: null,
    });
    expect(JSON.stringify(theirs)).not.toContain(hidden.projectId);
  });
});
