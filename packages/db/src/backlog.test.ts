import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  backlogChatMessages,
  backlogItems,
  backlogItemTickets,
  backlogJobs,
  projects,
} from "./schema.js";
import { seedRepository, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione del backlog di discovery (enum + tabelle + toggle
 * sul progetto) sia applicabile su un Postgres reale: persistenza di una voce
 * con embedding pgvector 1024-dim, round-trip dei default (status/requestCount)
 * e di un job intake, e del toggle backlogEnabled sul progetto.
 */
describe("schema: backlog di discovery", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("persiste una voce di backlog con embedding e ne applica i default", async () => {
    const { projectId } = await seedRepository(db);
    const embedding = Array.from({ length: 1024 }, (_, i) => (i % 10) / 10);

    const [inserted] = await db
      .insert(backlogItems)
      .values({
        projectId,
        title: "Consentire l'export CSV dei report",
        document: "Gli utenti vogliono esportare i report in CSV.",
        source: "ticket",
        embedding,
        suggested: { effort: 3, risk: "medium", urgency: "high", reason: "richiesta ricorrente" },
      })
      .returning();
    if (!inserted) throw new Error("insert della voce di backlog non ha restituito la riga");

    expect(inserted.status).toBe("new");
    expect(inserted.requestCount).toBe(1);
    expect(inserted.effort).toBeNull();
    expect(inserted.risk).toBeNull();
    expect(inserted.similarToId).toBeNull();
    expect(inserted.mergedIntoId).toBeNull();
    expect(inserted.suggested).toEqual({
      effort: 3,
      risk: "medium",
      urgency: "high",
      reason: "richiesta ricorrente",
    });

    const [readBack] = await db
      .select()
      .from(backlogItems)
      .where(eq(backlogItems.id, inserted.id));
    if (!readBack) throw new Error("read-back della voce di backlog non ha restituito la riga");
    expect(readBack.embedding).toHaveLength(1024);
    expect(readBack.embedding?.[1]).toBeCloseTo(0.1);
  });

  it("accoda un job intake con status queued di default", async () => {
    const { projectId } = await seedRepository(db);

    const [job] = await db
      .insert(backlogJobs)
      .values({ projectId, kind: "intake", payload: { ticketId: "abc-123" } })
      .returning();
    if (!job) throw new Error("insert del job di backlog non ha restituito la riga");

    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.kind).toBe("intake");
    expect(job.payload).toEqual({ ticketId: "abc-123" });
  });

  it("espone il toggle backlogEnabled sul progetto (default false)", async () => {
    const { projectId } = await seedRepository(db);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error("read del progetto non ha restituito la riga");
    expect(project.backlogEnabled).toBe(false);
  });

  it("il delete di una voce cascata su chat messages e legami coi ticket", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    const [item] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Voce da eliminare", source: "ticket" })
      .returning();
    if (!item) throw new Error("insert della voce di backlog non ha restituito la riga");

    await db.insert(backlogItemTickets).values({ itemId: item.id, ticketId });
    await db
      .insert(backlogChatMessages)
      .values({ itemId: item.id, role: "user", content: "Puoi dettagliare la richiesta?" });

    await db.delete(backlogItems).where(eq(backlogItems.id, item.id));

    const links = await db
      .select()
      .from(backlogItemTickets)
      .where(eq(backlogItemTickets.itemId, item.id));
    expect(links).toHaveLength(0);
    const messages = await db
      .select()
      .from(backlogChatMessages)
      .where(eq(backlogChatMessages.itemId, item.id));
    expect(messages).toHaveLength(0);
  });

  it("il delete della voce riferita da similarToId mette a NULL il riferimento", async () => {
    const { projectId } = await seedRepository(db);
    const [target] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Voce simile esistente", source: "manual" })
      .returning();
    if (!target) throw new Error("insert della voce target non ha restituito la riga");
    const [referrer] = await db
      .insert(backlogItems)
      .values({
        projectId,
        title: "Voce che riferisce la simile",
        source: "manual",
        similarToId: target.id,
      })
      .returning();
    if (!referrer) throw new Error("insert della voce referente non ha restituito la riga");
    expect(referrer.similarToId).toBe(target.id);

    await db.delete(backlogItems).where(eq(backlogItems.id, target.id));

    const [readBack] = await db
      .select()
      .from(backlogItems)
      .where(eq(backlogItems.id, referrer.id));
    if (!readBack) throw new Error("read-back della voce referente non ha restituito la riga");
    expect(readBack.similarToId).toBeNull();
  });
});
