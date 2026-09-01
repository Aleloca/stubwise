import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backlogItems, backlogItemTickets, tickets, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { convertBacklogItem } from "./backlog.js";
import type { Actor } from "./jobs.js";

let testDb: TestDb;
let db: Db;
/** Progetto in cui nascono tutte le voci del file. */
let projectId: string;

/**
 * L'attore non è un gate per la conversione (la rotta è `requireAuth`): serve
 * solo all'input, quindi un id sintetico basta — nessuna FK lo referenzia.
 */
const actor: Actor = { id: randomUUID(), role: "member" };

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

/** Inserisce una voce di backlog nel progetto di test. */
async function insertItem(
  overrides: Partial<typeof backlogItems.$inferInsert> = {},
): Promise<typeof backlogItems.$inferSelect> {
  const [row] = await db
    .insert(backlogItems)
    .values({ projectId, title: "Voce di test", source: "manual", ...overrides })
    .returning();
  return row!;
}

describe("convertBacklogItem", () => {
  it("voce inesistente → not_found", async () => {
    const result = await convertBacklogItem(db, { itemId: randomUUID(), actor });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("voce già convertita → already_converted", async () => {
    const item = await insertItem({ status: "converted" });
    const result = await convertBacklogItem(db, { itemId: item.id, actor });
    expect(result).toEqual({ ok: false, error: "already_converted" });
  });

  it("voce archiviata → not_convertible (e nessun ticket creato)", async () => {
    const item = await insertItem({ status: "archived" });
    const result = await convertBacklogItem(db, { itemId: item.id, actor });
    expect(result).toEqual({ ok: false, error: "not_convertible" });

    const links = await db
      .select()
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.itemId, item.id));
    expect(links).toHaveLength(0);
    // La voce resta archiviata: il claim non è nemmeno partito.
    const [row] = await db
      .select({ status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, item.id));
    expect(row!.status).toBe("archived");
  });

  it("voce convertibile → ticket task collegato, voce in converted", async () => {
    const item = await insertItem({
      title: "Idea da convertire",
      document: "# Design\n\nCorpo.",
      implementationPlan: "## Piano\n1. Step",
      originContent: "Testo di partenza",
      effort: 4,
      urgency: "urgent",
      status: "ready",
    });

    const result = await convertBacklogItem(db, { itemId: item.id, actor });
    expect(result).toMatchObject({ ok: true, ticketNumber: expect.any(Number) });
    const ticketId = result.ok ? result.ticketId : "";

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket!.type).toBe("task");
    expect(ticket!.title).toBe("Idea da convertire");
    expect(ticket!.body).toBe("# Design\n\nCorpo.");
    expect(ticket!.priority).toBe("urgent"); // dall'urgency
    expect(ticket!.effort).toBe(4);
    expect(ticket!.implementationPlan).toBe("## Piano\n1. Step");
    expect(ticket!.originContent).toBe("Testo di partenza");

    const links = await db
      .select()
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.itemId, item.id));
    expect(links).toHaveLength(1);
    expect(links[0]!.role).toBe("converted_to");

    const [row] = await db
      .select({ status: backlogItems.status })
      .from(backlogItems)
      .where(eq(backlogItems.id, item.id));
    expect(row!.status).toBe("converted");
  });

  it("due conversioni concorrenti: UNA vince, l'altra already_converted, UN solo ticket", async () => {
    // È la corsa del doppio "Procedi" sul pulse: il claim anti-TOCTOU serializza
    // le due transazioni sul row-lock della voce, la seconda trova 0 righe.
    const item = await insertItem({ status: "ready" });

    const [a, b] = await Promise.all([
      convertBacklogItem(db, { itemId: item.id, actor }),
      convertBacklogItem(db, { itemId: item.id, actor }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toEqual([{ ok: false, error: "already_converted" }]);

    // Un solo ticket e un solo link: la perdente non ha creato nulla.
    const links = await db
      .select()
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.itemId, item.id));
    expect(links).toHaveLength(1);
    expect(links[0]!.ticketId).toBe(winners[0]!.ok ? winners[0]!.ticketId : "");
  });
});
