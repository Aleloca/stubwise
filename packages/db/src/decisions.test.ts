import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { recordDecision } from "./decisions.js";
import { projectDecisions, tickets, users } from "./schema.js";
import { seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Helper di scrittura del REGISTRO DECISIONI (fase 5).
 *
 * Due proprietà sole, ma sono quelle che reggono tutto il registro:
 * l'idempotenza sull'unique `(project_id, source_key)` — un replay del writer
 * non aggiunge una seconda riga — e la sopravvivenza della riga a ciò che l'ha
 * originata (ticket cancellato, utente cancellato: la decisione resta).
 */
describe("recordDecision", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function decisionsOf(projectId: string) {
    return db.select().from(projectDecisions).where(eq(projectDecisions.projectId, projectId));
  }

  async function seedUser() {
    const [user] = await db
      .insert(users)
      .values({ email: `u-${randomUUID()}@example.com`, passwordHash: "x", role: "member" })
      .returning();
    return user!.id;
  }

  it("scrive la decisione e restituisce la riga creata", async () => {
    const { projectId, ticketId } = await seedTicket(db);
    const userId = await seedUser();

    const row = await recordDecision(db, {
      projectId,
      source: "ask_user",
      sourceKey: `question:${randomUUID()}`,
      sourceRef: { questionId: "q1", jobId: "j1" },
      ticketId,
      title: "Quale strada prendiamo?",
      context: "Contesto della scelta",
      decision: "La prima",
      consequences: "Si perde la retrocompatibilità",
      decidedByUserId: userId,
    });

    expect(row).not.toBeNull();
    expect(row?.decision).toBe("La prima");
    expect(row?.consequences).toBe("Si perde la retrocompatibilità");
    expect(row?.context).toBe("Contesto della scelta");
    expect(row?.sourceRef).toEqual({ questionId: "q1", jobId: "j1" });
    expect(row?.decidedByUserId).toBe(userId);
    expect(row?.supersededById).toBeNull();
    expect(await decisionsOf(projectId)).toHaveLength(1);
  });

  it("un replay con la stessa (projectId, sourceKey) non aggiunge righe", async () => {
    const { projectId } = await seedTicket(db, { number: 2 });
    const sourceKey = `plan_review:${randomUUID()}:1`;

    const first = await recordDecision(db, {
      projectId,
      source: "plan_review",
      sourceKey,
      title: "Ticket X",
      decision: "Piano approvato",
    });
    const replay = await recordDecision(db, {
      projectId,
      source: "plan_review",
      sourceKey,
      title: "Ticket X",
      // Anche con un testo DIVERSO: la prima scrittura vince, il replay non
      // riscrive nulla (onConflictDoNothing, non onConflictDoUpdate).
      decision: "Piano rifiutato",
    });

    expect(first).not.toBeNull();
    // `null` = nessuna riga scritta: è il segnale che il chiamante ha davanti un
    // replay, non un errore.
    expect(replay).toBeNull();
    const rows = await decisionsOf(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe("Piano approvato");
  });

  it("la stessa sourceKey su progetti diversi sono due decisioni distinte", async () => {
    const a = await seedTicket(db, { number: 3 });
    const b = await seedTicket(db, { number: 4 });
    const sourceKey = `pulse:${randomUUID()}`;

    expect(
      await recordDecision(db, {
        projectId: a.projectId,
        source: "pulse",
        sourceKey,
        title: "T",
        decision: "D",
      }),
    ).not.toBeNull();
    expect(
      await recordDecision(db, {
        projectId: b.projectId,
        source: "pulse",
        sourceKey,
        title: "T",
        decision: "D",
      }),
    ).not.toBeNull();
  });

  it("la decisione sopravvive alla cancellazione del ticket (ticket_id SET NULL)", async () => {
    const { projectId, ticketId } = await seedTicket(db, { number: 5 });

    await recordDecision(db, {
      projectId,
      source: "manual",
      sourceKey: `manual:${randomUUID()}`,
      ticketId,
      title: "Decisione legata a un ticket",
      decision: "Fatto così",
    });

    await db.delete(tickets).where(eq(tickets.id, ticketId));

    const rows = await decisionsOf(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ticketId).toBeNull();
    expect(rows[0]?.title).toBe("Decisione legata a un ticket");
  });

  it("rifiuta una sorgente fuori dal CHECK", async () => {
    const { projectId } = await seedTicket(db, { number: 6 });

    await expect(
      recordDecision(db, {
        projectId,
        source: "AI" as unknown as "manual",
        sourceKey: `bad:${randomUUID()}`,
        title: "T",
        decision: "D",
      }),
    ).rejects.toThrow();
  });

  it("scritta dentro una transazione annullata, la decisione non resta", async () => {
    const { projectId } = await seedTicket(db, { number: 7 });

    await expect(
      db.transaction(async (tx) => {
        await recordDecision(tx, {
          projectId,
          source: "manual",
          sourceKey: `manual:${randomUUID()}`,
          title: "T",
          decision: "D",
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(await decisionsOf(projectId)).toHaveLength(0);
  });
});
