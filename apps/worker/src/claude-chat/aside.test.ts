import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentSessionEvents, agentSessions } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { writeCapabilities, writeStalledAside } from "./aside.js";

/**
 * Area 10, F3 (S2): l'evento `aside` del lavoro fermo, scritto dal worker con
 * le task ferme già lette (`GET /api/tasks/stalled`, le soglie dei progetti).
 * Solo id, numeri, date e il tipo del motivo; l'ipotesi «fuori piano» quando
 * la più vecchia del primo progetto è ferma per inattività e senza settimana.
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
const P = randomUUID();
const item = (id: string, kind: string, since: string, plannedWeek: string | null) => ({
  task: { id, projectId: P, code: "AUD-1", title: "TITOLO", plannedWeek },
  stall: { reason: { kind, note: "NOTA" }, since, days: 9 },
});

describe("l'aside del lavoro fermo", () => {
  it("una riga per progetto (conteggio, la più vecchia, da quando e il tipo del motivo) e l'ipotesi «fuori piano»; niente testo", async () => {
    const a = randomUUID();
    const sid = await session();
    await writeStalledAside(t.db, sid, [item(a, "idle", "2026-11-01T00:00:00.000Z", null), item(randomUUID(), "manual", "2026-11-05T00:00:00.000Z", null)]);
    const [e] = await asides(sid);
    expect(e!.data).toEqual({ rows: [{ projectId: P, count: 2, oldest: { ticketId: a, stalledSince: "2026-11-01T00:00:00.000Z", reason: "idle" } }], hypothesis: { ticketId: a, key: "out_of_plan" } });
    expect(JSON.stringify(e!.data)).not.toMatch(/TITOLO|NOTA/);
  });

  it("nessuna ipotesi se la più vecchia è pianificata, o se è ferma per un altro motivo (come il prototipo)", async () => {
    const planned = await session();
    await writeStalledAside(t.db, planned, [item(randomUUID(), "idle", "2026-11-01T00:00:00.000Z", "2026-11-16")]);
    expect((await asides(planned))[0]!.data).toMatchObject({ hypothesis: null });
    const other = await session();
    await writeStalledAside(t.db, other, [item(randomUUID(), "unassigned", "2026-11-01T00:00:00.000Z", null)]);
    expect((await asides(other))[0]!.data).toMatchObject({ hypothesis: null });
  });

  it("nessuna riga, nessun evento; mai in un turno di @Claude", async () => {
    const empty = await session();
    await writeStalledAside(t.db, empty, []);
    expect(await asides(empty)).toEqual([]);
    const mention = await session("chat_mention");
    await writeStalledAside(t.db, mention, [item(randomUUID(), "idle", "2026-11-01T00:00:00.000Z", null)]);
    expect(await asides(mention)).toEqual([]);
  });
});

describe("area 10, F7: l'evento `capabilities`", () => {
  const events = (sid: string) => t.db.select().from(agentSessionEvents).where(and(eq(agentSessionEvents.sessionId, sid), eq(agentSessionEvents.type, "capabilities")));

  it("gli id che dà il server, e solo quelli conosciuti: il modello non sceglie niente", async () => {
    const sid = await session();
    expect(await writeCapabilities(t.db, sid, { items: ["stalled", "spend", "inventata", 3] })).toEqual({ items: ["stalled", "spend"] });
    const [e] = await events(sid);
    expect(e!.data).toEqual({ items: ["stalled", "spend"] });
  });

  it("mai nei turni di @Claude nella Chat, e niente evento da una risposta illeggibile", async () => {
    const mention = await session("chat_mention");
    expect(await writeCapabilities(t.db, mention, { items: ["stalled"] })).toBeNull();
    expect(await events(mention)).toEqual([]);
    const sid = await session();
    expect(await writeCapabilities(t.db, sid, null)).toBeNull();
    expect(await events(sid)).toEqual([]);
  });
});
