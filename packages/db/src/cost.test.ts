import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { monthlyCostUsd, ticketCostUsd } from "./cost.js";
import { agentRuns, aiJobs } from "./schema.js";
import { seedTicket as seedTicketRow, startTestDb, type TestDb } from "./testing.js";

/**
 * Verifica i due helper di lettura costo su un Postgres reale: la somma dei
 * costi per ticket (join agent_runs → ai_jobs), il coalesce dei run NULL a 0,
 * e la finestra del mese corrente (date_trunc('month', now())) che esclude i
 * run del mese scorso.
 */
describe("cost: ticketCostUsd e monthlyCostUsd", () => {
  let testDb: TestDb;
  let db: Db;
  let ticketCounter = 0;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedTicket(): Promise<string> {
    ticketCounter++;
    const { ticketId } = await seedTicketRow(db, { number: ticketCounter });
    return ticketId;
  }

  async function seedJob(ticketId: string): Promise<string> {
    const [job] = await db.insert(aiJobs).values({ ticketId }).returning();
    if (!job) throw new Error("insert del job non ha restituito la riga");
    return job.id;
  }

  async function seedRun(
    jobId: string,
    costUsd: string | null,
    opts: { ageDaysAgo?: number } = {},
  ): Promise<void> {
    const createdAt =
      opts.ageDaysAgo === undefined
        ? undefined
        : sql`now() - (${opts.ageDaysAgo} || ' days')::interval`;
    await db.insert(agentRuns).values({
      jobId,
      phase: "fix",
      model: "test-model",
      costUsd,
      ...(createdAt ? { createdAt: createdAt as never } : {}),
    });
  }

  it("somma i costi dei run di un ticket joinando i job", async () => {
    const ticketA = await seedTicket();
    const jobA = await seedJob(ticketA);
    await seedRun(jobA, "0.100000");
    await seedRun(jobA, "0.250000");

    const ticketB = await seedTicket();
    const jobB = await seedJob(ticketB);
    await seedRun(jobB, "1.000000");

    expect(await ticketCostUsd(db, ticketA)).toBeCloseTo(0.35, 6);
    expect(await ticketCostUsd(db, ticketB)).toBeCloseTo(1.0, 6);
  });

  it("torna 0 per un ticket senza run", async () => {
    const ticket = await seedTicket();
    expect(await ticketCostUsd(db, ticket)).toBe(0);
  });

  it("conta i run con cost_usd NULL come 0 (non rompe la somma)", async () => {
    const ticket = await seedTicket();
    const job = await seedJob(ticket);
    await seedRun(job, "0.200000");
    await seedRun(job, null);

    expect(await ticketCostUsd(db, ticket)).toBeCloseTo(0.2, 6);
  });

  it("monthlyCostUsd include i run del mese corrente ed esclude il mese scorso", async () => {
    const before = await monthlyCostUsd(db);

    const ticket = await seedTicket();
    const job = await seedJob(ticket);
    // Run del mese corrente: incluso.
    await seedRun(job, "0.500000");
    // Run di 40 giorni fa (mese scorso): escluso dalla finestra.
    await seedRun(job, "9.000000", { ageDaysAgo: 40 });

    const after = await monthlyCostUsd(db);
    // Solo il run corrente (0.5) deve incrementare il totale; i 9.0 del mese
    // scorso restano fuori.
    expect(after - before).toBeCloseTo(0.5, 6);
  });
});
