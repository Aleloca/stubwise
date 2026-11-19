import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentSessionEvents, agentSessions, tickets } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { writeStalledAside } from "./aside.js";

/**
 * Area 10, F3 (S2): l'evento `aside` del lavoro fermo, scritto dal worker col
 * polso già letto. Solo id, numeri e date; l'ipotesi «fuori piano» viene dalla
 * settimana pianificata della ferma più vecchia del primo progetto.
 */
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function session(kind: "free" | "chat_mention" = "free"): Promise<string> {
  const [s] = await t.db.insert(agentSessions).values({ ownerKey: `${kind}:${randomUUID()}`, kind, title: "t" }).returning();
  return s!.id;
}
const asides = (sid: string) => t.db.select().from(agentSessionEvents).where(and(eq(agentSessionEvents.sessionId, sid), eq(agentSessionEvents.type, "aside")));

describe("l'aside del lavoro fermo", () => {
  it("una riga per progetto (conteggio, la più vecchia e da quando) e l'ipotesi «fuori piano» se non è pianificata; niente testo", async () => {
    const { ticketId, projectId } = await seedTicket(t.db);
    const pulse = [{ projectId, projectName: "P", stalled: [
      { ticketId, ticketNumber: 1, title: "TITOLO", stalledSince: "2026-11-01T00:00:00.000Z", reason: "to_prepare" },
      { ticketId: randomUUID(), ticketNumber: 2, title: "x", stalledSince: "2026-11-05T00:00:00.000Z", reason: "interrupted" },
    ] }];
    const sid = await session();
    await writeStalledAside(t.db, sid, pulse, "/api/projects/pulse");
    const [e] = await asides(sid);
    expect(e!.data).toEqual({ rows: [{ projectId, count: 2, oldest: { ticketId, stalledSince: "2026-11-01T00:00:00.000Z", reason: "to_prepare" } }], hypothesis: { ticketId, key: "out_of_plan" } });
    expect(JSON.stringify(e!.data)).not.toContain("TITOLO");
  });

  it("pianificata in una settimana: nessuna ipotesi", async () => {
    const { ticketId, projectId } = await seedTicket(t.db, { number: 2 });
    await t.db.update(tickets).set({ plannedWeek: "2026-11-16" }).where(eq(tickets.id, ticketId));
    const sid = await session();
    await writeStalledAside(t.db, sid, [{ projectId, projectName: "P", stalled: [{ ticketId, ticketNumber: 1, stalledSince: "2026-11-01T00:00:00.000Z", reason: "to_prepare" }] }], "/api/projects/pulse");
    expect((await asides(sid))[0]!.data).toMatchObject({ hypothesis: null });
  });

  it("nessuna riga, nessun evento; mai in un turno di @Claude", async () => {
    const empty = await session();
    await writeStalledAside(t.db, empty, [{ projectId: randomUUID(), projectName: "P", stalled: [] }], "/api/projects/pulse");
    expect(await asides(empty)).toEqual([]);
    const { ticketId, projectId } = await seedTicket(t.db, { number: 3 });
    const mention = await session("chat_mention");
    await writeStalledAside(t.db, mention, [{ projectId, projectName: "P", stalled: [{ ticketId, ticketNumber: 1, stalledSince: "2026-11-01T00:00:00.000Z", reason: "to_prepare" }] }], "/api/projects/pulse");
    expect(await asides(mention)).toEqual([]);
  });
});
