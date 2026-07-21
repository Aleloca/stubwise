import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import {
  backlogChatMessages,
  backlogCodeSessions,
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

  it("accoda un job chat_turn (nuovo valore enum 0055) con payload {itemId, userMessageId}", async () => {
    const { projectId } = await seedRepository(db);
    const [item] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Voce con sessione", source: "manual" })
      .returning();
    const [msg] = await db
      .insert(backlogChatMessages)
      .values({ itemId: item!.id, role: "user", content: "come funziona il modulo X?" })
      .returning();

    const [job] = await db
      .insert(backlogJobs)
      .values({
        projectId,
        kind: "chat_turn",
        payload: { itemId: item!.id, userMessageId: msg!.id },
      })
      .returning();
    if (!job) throw new Error("insert del job chat_turn non ha restituito la riga");

    expect(job.kind).toBe("chat_turn");
    expect(job.status).toBe("queued");
    expect(job.payload).toEqual({ itemId: item!.id, userMessageId: msg!.id });
  });

  it("persiste una sessione di analisi con default (active, timestamp) e cliSessionId null", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const [item] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Voce da analizzare", source: "manual" })
      .returning();

    const [session] = await db
      .insert(backlogCodeSessions)
      .values({ itemId: item!.id, repositoryId })
      .returning();
    if (!session) throw new Error("insert della sessione non ha restituito la riga");

    expect(session.status).toBe("active");
    expect(session.cliSessionId).toBeNull();
    expect(session.closedAt).toBeNull();
    expect(session.startedAt).toBeInstanceOf(Date);
    expect(session.lastActivityAt).toBeInstanceOf(Date);
  });

  it("indice unico parziale: due sessioni active sulla stessa voce → errore", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const [item] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Voce con una sola sessione attiva", source: "manual" })
      .returning();

    await db.insert(backlogCodeSessions).values({ itemId: item!.id, repositoryId });
    await expect(
      db.insert(backlogCodeSessions).values({ itemId: item!.id, repositoryId }),
    ).rejects.toThrow();
  });

  it("indice unico parziale: una closed + una active sulla stessa voce → ok", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const [item] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Voce con storico di sessioni", source: "manual" })
      .returning();

    // Una sessione chiusa (non partecipa all'indice parziale)…
    await db
      .insert(backlogCodeSessions)
      .values({ itemId: item!.id, repositoryId, status: "closed", closedAt: new Date() });
    // …e poi una attiva: consentito.
    const [active] = await db
      .insert(backlogCodeSessions)
      .values({ itemId: item!.id, repositoryId })
      .returning();
    expect(active!.status).toBe("active");

    const rows = await db
      .select()
      .from(backlogCodeSessions)
      .where(eq(backlogCodeSessions.itemId, item!.id));
    expect(rows).toHaveLength(2);
  });

  it("il delete della voce cascata sulle sessioni di analisi", async () => {
    const { projectId, repositoryId } = await seedRepository(db);
    const [item] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Voce con sessione da eliminare", source: "manual" })
      .returning();
    await db.insert(backlogCodeSessions).values({ itemId: item!.id, repositoryId });

    await db.delete(backlogItems).where(eq(backlogItems.id, item!.id));

    const rows = await db
      .select()
      .from(backlogCodeSessions)
      .where(eq(backlogCodeSessions.itemId, item!.id));
    expect(rows).toHaveLength(0);
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
