import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { agentQuestions, aiJobs, tickets, users } from "./schema.js";
import { expectSqlState, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica che la migrazione della pianificazione interattiva (valori enum
 * `awaiting_input`/`plan_continue`, colonna `ai_jobs.cli_session_id`, tabella
 * `agent_questions`) sia applicabile su un Postgres reale: parcheggio del job
 * in attesa di risposta, ripresa `plan_continue`, default della domanda,
 * invariante "una sola domanda aperta per job" (indice unico parziale), CHECK
 * di coerenza risposta⇔istante di risposta e cascate.
 */
describe("schema: domande dell'agente (pianificazione interattiva)", () => {
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

  /** Job appena parcheggiato in attesa di una risposta, con la sessione CLI salvata. */
  async function seedAwaitingJob(): Promise<{ ticketId: string; jobId: string }> {
    const { ticketId } = await seedTicket(db);
    const [job] = await db
      .insert(aiJobs)
      .values({ ticketId, status: "awaiting_input", cliSessionId: randomUUID() })
      .returning();
    if (!job) throw new Error("insert del job non ha restituito la riga");
    return { ticketId, jobId: job.id };
  }

  it("ai_jobs: stato awaiting_input, cliSessionId nullable e ripresa plan_continue", async () => {
    const { ticketId } = await seedTicket(db);

    // Job normale: nessuna sessione CLI da riprendere.
    const [nuovo] = await db.insert(aiJobs).values({ ticketId }).returning();
    if (!nuovo) throw new Error("insert del job non ha restituito la riga");
    expect(nuovo.cliSessionId).toBeNull();

    // Parcheggio in attesa di risposta: la sessione CLI serve al `--resume`.
    const sessionId = randomUUID();
    const [parcheggiato] = await db
      .update(aiJobs)
      .set({ status: "awaiting_input", cliSessionId: sessionId })
      .where(eq(aiJobs.id, nuovo.id))
      .returning();
    expect(parcheggiato?.status).toBe("awaiting_input");
    expect(parcheggiato?.cliSessionId).toBe(sessionId);

    // Risposta arrivata: torna in coda per continuare la pianificazione.
    const [ripreso] = await db
      .update(aiJobs)
      .set({ status: "queued", resumeMode: "plan_continue" })
      .where(eq(aiJobs.id, nuovo.id))
      .returning();
    expect(ripreso?.status).toBe("queued");
    expect(ripreso?.resumeMode).toBe("plan_continue");
  });

  it("agent_questions: default della domanda appena posta", async () => {
    const { ticketId, jobId } = await seedAwaitingJob();

    const [domanda] = await db
      .insert(agentQuestions)
      .values({
        jobId,
        ticketId,
        round: 1,
        question: "Quale strategia di migrazione preferisci?",
        options: [
          { label: "Migrazione in-place", consequence: "Downtime di pochi minuti" },
          { label: "Doppia scrittura" },
        ],
        recommendedIndex: 0,
      })
      .returning();
    if (!domanda) throw new Error("insert della domanda non ha restituito la riga");

    expect(domanda.round).toBe(1);
    expect(domanda.options).toEqual([
      { label: "Migrazione in-place", consequence: "Downtime di pochi minuti" },
      { label: "Doppia scrittura" },
    ]);
    expect(domanda.recommendedIndex).toBe(0);
    // Il testo libero è ammesso salvo diverso volere dell'agente.
    expect(domanda.allowFreeText).toBe(true);
    expect(domanda.askedAt).toBeInstanceOf(Date);
    expect(domanda.answer).toBeNull();
    expect(domanda.answeredAt).toBeNull();
    expect(domanda.answeredByUserId).toBeNull();

    // Una domanda senza raccomandazione e senza testo libero è altrettanto valida.
    const [secca] = await db
      .insert(agentQuestions)
      .values({
        jobId,
        ticketId,
        round: 2,
        question: "Procedo?",
        options: [{ label: "Sì" }, { label: "No" }],
        allowFreeText: false,
        // La prima domanda deve risultare chiusa, altrimenti l'unico parziale
        // rifiuterebbe questa seconda: la si risponde qui sotto.
        answer: { optionIndex: 1 },
        answeredAt: new Date(),
      })
      .returning();
    expect(secca?.recommendedIndex).toBeNull();
    expect(secca?.allowFreeText).toBe(false);
    expect(secca?.answer).toEqual({ optionIndex: 1 });
  });

  it("indice unico parziale: una sola domanda aperta per job", async () => {
    const { ticketId, jobId } = await seedAwaitingJob();
    const values = {
      jobId,
      ticketId,
      round: 1,
      question: "Domanda aperta",
      options: [{ label: "A" }, { label: "B" }],
    };

    const [prima] = await db.insert(agentQuestions).values(values).returning();
    if (!prima) throw new Error("insert della prima domanda non ha restituito la riga");

    // Seconda domanda aperta sullo stesso job: rifiutata dall'indice unico.
    await expectSqlState(db.insert(agentQuestions).values({ ...values, round: 2 }), "23505");

    // Risposta alla prima: il posto si libera e il round successivo entra.
    const rispondente = await seedUser();
    await db
      .update(agentQuestions)
      .set({ answer: { text: "a mano" }, answeredAt: new Date(), answeredByUserId: rispondente })
      .where(eq(agentQuestions.id, prima.id));
    const [seconda] = await db
      .insert(agentQuestions)
      .values({ ...values, round: 2 })
      .returning();
    expect(seconda?.round).toBe(2);

    // Due domande aperte su job DIVERSI convivono: il vincolo è per-job.
    const altro = await seedAwaitingJob();
    await db
      .insert(agentQuestions)
      .values({ ...values, jobId: altro.jobId, ticketId: altro.ticketId });
    const aperte = await db
      .select()
      .from(agentQuestions)
      .where(sql`answered_at is null and job_id in (${jobId}, ${altro.jobId})`);
    expect(aperte).toHaveLength(2);
  });

  it("CHECK answer: risposta e istante di risposta stanno o cadono insieme", async () => {
    const { ticketId, jobId } = await seedAwaitingJob();

    // Risposta senza istante: non si saprebbe quando è stata data.
    await expectSqlState(
      db.execute(
        sql`insert into agent_questions (job_id, ticket_id, round, question, options, answer)
            values (${jobId}, ${ticketId}, 1, 'Domanda', '[]'::jsonb, '{"optionIndex":0}'::jsonb)`,
      ),
      "23514",
    );
    // Istante senza risposta: la domanda risulterebbe chiusa a vuoto.
    await expectSqlState(
      db.execute(
        sql`insert into agent_questions (job_id, ticket_id, round, question, options, answered_at)
            values (${jobId}, ${ticketId}, 1, 'Domanda', '[]'::jsonb, now())`,
      ),
      "23514",
    );
  });

  it("cascate: la domanda muore col job, col ticket e sopravvive a chi ha risposto", async () => {
    const { ticketId, jobId } = await seedAwaitingJob();
    const rispondente = await seedUser();
    const [domanda] = await db
      .insert(agentQuestions)
      .values({
        jobId,
        ticketId,
        round: 1,
        question: "Domanda",
        options: [{ label: "A" }],
        answer: { optionIndex: 0 },
        answeredAt: new Date(),
        answeredByUserId: rispondente,
      })
      .returning();
    if (!domanda) throw new Error("insert della domanda non ha restituito la riga");

    // L'utente se ne va, la domanda resta (storico leggibile) senza autore.
    await db.delete(users).where(eq(users.id, rispondente));
    const [orfana] = await db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.id, domanda.id));
    expect(orfana?.answeredByUserId).toBeNull();

    // Il job se ne va, la domanda con lui.
    await db.delete(aiJobs).where(eq(aiJobs.id, jobId));
    const dopoJob = await db.select().from(agentQuestions).where(eq(agentQuestions.id, domanda.id));
    expect(dopoJob).toHaveLength(0);

    // Stessa cosa dal lato ticket (cancellazione del ticket d'origine).
    const altro = await seedAwaitingJob();
    await db.insert(agentQuestions).values({
      jobId: altro.jobId,
      ticketId: altro.ticketId,
      round: 1,
      question: "Domanda",
      options: [{ label: "A" }],
    });
    await db.delete(tickets).where(eq(tickets.id, altro.ticketId));
    const dopoTicket = await db
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.ticketId, altro.ticketId));
    expect(dopoTicket).toHaveLength(0);
  });
});
