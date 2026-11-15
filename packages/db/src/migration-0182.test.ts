import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serverFixes, serverOperationApprovals, servers, tickets } from "./schema.js";
import { expectSqlState, seedRepository, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0182 (14 nov 2026, area 8, fetta 4b, S6): la correzione di un
 * server nel progetto attribuito. I CHECK: in attesa d'approvazione c'è sempre
 * un piano di 1–10 passi; approvata o in esecuzione solo con un'approvazione;
 * una correzione per task. La sorgente `server` dei ticket.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function scene() {
  const [s] = await t.db.insert(servers).values({ name: `s-${randomUUID()}`, keyHash: randomUUID() }).returning();
  const { projectId } = await seedRepository(t.db);
  const { ticketId } = await seedTicket(t.db, { projectId });
  return { serverId: s!.id, projectId, ticketId };
}
const step = { action: "container.restart", params: { container: "web", timeoutSeconds: 10 }, why: "riparte" };

describe("0182: i guardiani della correzione", () => {
  it("in attesa senza passi, o con più di 10 → no; con un piano → sì; una per task", async () => {
    const { serverId, projectId, ticketId } = await scene();
    await expectSqlState(t.db.insert(serverFixes).values({ taskId: ticketId, serverId, projectId, status: "awaiting_approval" }), "23514");
    await expectSqlState(t.db.insert(serverFixes).values({ taskId: ticketId, serverId, projectId, status: "awaiting_approval", steps: Array(11).fill(step) }), "23514");
    await t.db.insert(serverFixes).values({ taskId: ticketId, serverId, projectId, status: "awaiting_approval", steps: [step] });
    await expectSqlState(t.db.insert(serverFixes).values({ taskId: ticketId, serverId, projectId }), "23505");
  });

  it("approvata o in esecuzione solo con un'approvazione; uno stato fuori elenco mai", async () => {
    const { serverId, projectId, ticketId } = await scene();
    const [fix] = await t.db.insert(serverFixes).values({ taskId: ticketId, serverId, projectId, status: "awaiting_approval", steps: [step] }).returning();
    await expectSqlState(t.db.update(serverFixes).set({ status: "running" }).where(eq(serverFixes.id, fix!.id)), "23514");
    await expectSqlState(t.db.update(serverFixes).set({ status: "deployed" as never }).where(eq(serverFixes.id, fix!.id)), "23514");
    const [a] = await t.db.insert(serverOperationApprovals).values({ serverId, taskId: ticketId, steps: [step] }).returning();
    await t.db.update(serverFixes).set({ status: "running", approvalId: a!.id }).where(eq(serverFixes.id, fix!.id));
  });

  it("la sorgente `server` dei ticket esiste", async () => {
    const { ticketId } = await scene();
    await t.db.update(tickets).set({ source: "server" }).where(eq(tickets.id, ticketId));
    expect((await t.db.select({ source: tickets.source }).from(tickets).where(eq(tickets.id, ticketId)))[0]!.source).toBe("server");
  });
});
