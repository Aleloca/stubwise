import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { aiJobs, backlogItems, backlogQuestions, tickets, users } from "./schema.js";
import { expectSqlState, seedRepository, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione 0072 (fase 7 — workflow guidato) sia applicabile
 * su un Postgres reale: `backlog_questions` (gemella di `agent_questions`, con
 * l'uscita "non ora" in più), la pre-approvazione del piano su `tickets` e il
 * riassunto del fallimento su `ai_jobs`.
 */
describe("schema: workflow guidato (fase 7)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedUser(): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({
        email: `operatore-${randomUUID()}@example.com`,
        passwordHash: "x",
        role: "member",
      })
      .returning();
    if (!user) throw new Error("insert dell'utente non ha restituito la riga");
    return user.id;
  }

  async function seedBacklogItem(overrides: { projectId?: string } = {}): Promise<string> {
    const projectId = overrides.projectId ?? (await seedRepository(db)).projectId;
    const [item] = await db
      .insert(backlogItems)
      .values({ projectId, title: "Voce di test", source: "manual" })
      .returning();
    if (!item) throw new Error("insert della voce di backlog non ha restituito la riga");
    return item.id;
  }

  describe("backlog_questions", () => {
    it("default della domanda appena posta", async () => {
      const backlogItemId = await seedBacklogItem();

      const [domanda] = await db
        .insert(backlogQuestions)
        .values({
          backlogItemId,
          question: "Preferisci un import CSV o un form manuale?",
          options: [{ label: "Import CSV", consequence: "Serve un file già pronto" }, { label: "Form manuale" }],
          recommendedIndex: 1,
        })
        .returning();
      if (!domanda) throw new Error("insert della domanda non ha restituito la riga");

      expect(domanda.options).toEqual([
        { label: "Import CSV", consequence: "Serve un file già pronto" },
        { label: "Form manuale" },
      ]);
      expect(domanda.recommendedIndex).toBe(1);
      expect(domanda.allowFreeText).toBe(true);
      expect(domanda.askedAt).toBeInstanceOf(Date);
      expect(domanda.answer).toBeNull();
      expect(domanda.answeredAt).toBeNull();
      expect(domanda.answeredByUserId).toBeNull();
      expect(domanda.dismissedAt).toBeNull();
    });

    it("indice unico parziale: una sola domanda aperta per voce", async () => {
      const backlogItemId = await seedBacklogItem();
      const values = {
        backlogItemId,
        question: "Domanda aperta",
        options: [{ label: "A" }, { label: "B" }],
      };

      const [prima] = await db.insert(backlogQuestions).values(values).returning();
      if (!prima) throw new Error("insert della prima domanda non ha restituito la riga");

      // Seconda domanda aperta sulla stessa voce: rifiutata dall'indice unico.
      await expectSqlState(db.insert(backlogQuestions).values(values), "23505");

      // Risposta alla prima: il posto si libera.
      const rispondente = await seedUser();
      await db
        .update(backlogQuestions)
        .set({ answer: { text: "a mano" }, answeredAt: new Date(), answeredByUserId: rispondente })
        .where(eq(backlogQuestions.id, prima.id));
      const [seconda] = await db.insert(backlogQuestions).values(values).returning();
      expect(seconda?.id).toBeDefined();

      // "Non ora" sulla seconda: chiude senza rispondere e libera di nuovo il posto.
      await db
        .update(backlogQuestions)
        .set({ dismissedAt: new Date() })
        .where(eq(backlogQuestions.id, seconda!.id));
      const [terza] = await db.insert(backlogQuestions).values(values).returning();
      expect(terza?.answer).toBeNull();
      expect(terza?.dismissedAt).toBeNull();

      // Due domande aperte su voci DIVERSE convivono: il vincolo è per-voce.
      const altraVoce = await seedBacklogItem();
      await db.insert(backlogQuestions).values({ ...values, backlogItemId: altraVoce });
      const aperte = await db
        .select()
        .from(backlogQuestions)
        .where(
          sql`answered_at is null and dismissed_at is null and backlog_item_id in (${backlogItemId}, ${altraVoce})`,
        );
      expect(aperte).toHaveLength(2);
    });

    it("CHECK answer: risposta e istante di risposta stanno o cadono insieme", async () => {
      const backlogItemId = await seedBacklogItem();

      await expectSqlState(
        db.execute(
          sql`insert into backlog_questions (backlog_item_id, question, options, answer)
              values (${backlogItemId}, 'Domanda', '[]'::jsonb, '{"optionIndex":0}'::jsonb)`,
        ),
        "23514",
      );
      await expectSqlState(
        db.execute(
          sql`insert into backlog_questions (backlog_item_id, question, options, answered_at)
              values (${backlogItemId}, 'Domanda', '[]'::jsonb, now())`,
        ),
        "23514",
      );

      // "Non ora" senza risposta NON viola il CHECK: dismissed_at è indipendente.
      const [dismissedSubito] = await db
        .insert(backlogQuestions)
        .values({
          backlogItemId,
          question: "Domanda",
          options: [{ label: "A" }],
          dismissedAt: new Date(),
        })
        .returning();
      expect(dismissedSubito?.answer).toBeNull();
      expect(dismissedSubito?.answeredAt).toBeNull();
    });

    it("cascata: la domanda muore con la voce di backlog e sopravvive a chi ha risposto", async () => {
      const backlogItemId = await seedBacklogItem();
      const rispondente = await seedUser();
      const [domanda] = await db
        .insert(backlogQuestions)
        .values({
          backlogItemId,
          question: "Domanda",
          options: [{ label: "A" }],
          answer: { optionIndex: 0 },
          answeredAt: new Date(),
          answeredByUserId: rispondente,
        })
        .returning();
      if (!domanda) throw new Error("insert della domanda non ha restituito la riga");

      // L'utente se ne va, la domanda resta senza autore.
      await db.delete(users).where(eq(users.id, rispondente));
      const [orfana] = await db
        .select()
        .from(backlogQuestions)
        .where(eq(backlogQuestions.id, domanda.id));
      expect(orfana?.answeredByUserId).toBeNull();

      // La voce se ne va, la domanda con lei.
      await db.delete(backlogItems).where(eq(backlogItems.id, backlogItemId));
      const dopo = await db.select().from(backlogQuestions).where(eq(backlogQuestions.id, domanda.id));
      expect(dopo).toHaveLength(0);
    });
  });

  describe("tickets: pre-approvazione del piano", () => {
    it("nullable di default, digest e approvatore round-trip, FK set null", async () => {
      const { ticketId } = await seedTicket(db);
      const [prima] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      expect(prima?.planApprovedAt).toBeNull();
      expect(prima?.planApprovedByUserId).toBeNull();
      expect(prima?.planApprovedDigest).toBeNull();

      const maintainer = await seedUser();
      const digest = "a".repeat(64);
      await db
        .update(tickets)
        .set({
          implementationPlan: "## Piano\n1. fai questo",
          planApprovedAt: new Date(),
          planApprovedByUserId: maintainer,
          planApprovedDigest: digest,
        })
        .where(eq(tickets.id, ticketId));
      const [approvato] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      expect(approvato?.planApprovedAt).toBeInstanceOf(Date);
      expect(approvato?.planApprovedByUserId).toBe(maintainer);
      expect(approvato?.planApprovedDigest).toBe(digest);

      // Il maintainer se ne va: l'approvazione (e il digest) restano leggibili.
      await db.delete(users).where(eq(users.id, maintainer));
      const [orfano] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
      expect(orfano?.planApprovedByUserId).toBeNull();
      expect(orfano?.planApprovedDigest).toBe(digest);
    });
  });

  describe("ai_jobs: riassunto del fallimento", () => {
    it("nullable di default e scrivibile", async () => {
      const { ticketId } = await seedTicket(db);
      const [job] = await db.insert(aiJobs).values({ ticketId, status: "failed" }).returning();
      if (!job) throw new Error("insert del job non ha restituito la riga");
      expect(job.failureSummary).toBeNull();

      const [aggiornato] = await db
        .update(aiJobs)
        .set({ failureSummary: "Il test end-to-end è fallito: serve un maintainer." })
        .where(eq(aiJobs.id, job.id))
        .returning();
      expect(aggiornato?.failureSummary).toBe("Il test end-to-end è fallito: serve un maintainer.");
    });
  });
});
