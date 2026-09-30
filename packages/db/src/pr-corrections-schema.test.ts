import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client.js";
import { aiJobs, gitAccounts, prCorrections, projects, repositories, ticketRepositories } from "./schema.js";
import {
  expectSqlState,
  seedGitAccount,
  seedTicket,
  seedTicketRepository,
  startTestDb,
  type TestDb,
} from "./testing.js";

/**
 * Migrazione 0081 vista da drizzle: le colonne dichiarate in `schema.ts`
 * devono esistere nelle tabelle che la migrazione crea, e i
 * vincoli che reggono la coda delle correzioni — una `pending` e una `queued`
 * per PR, un job per correzione — devono stare nel DB, non nel codice.
 *
 * Limite: le tabelle le crea lo SQL, quindi questo test NON vede divergenze di
 * nomi di indici/vincoli o di predicati fra schema e migrazione; quella parità
 * si controlla a mano con `npx drizzle-kit export` in `packages/db`.
 */
describe("schema: pr_corrections (ciclo di correzione post-PR)", () => {
  let testDb: TestDb;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.stop();
  });

  async function seedPr(): Promise<{ ticketId: string; repositoryId: string; projectId: string }> {
    const seeded = await seedTicket(db);
    await seedTicketRepository(db, {
      ticketId: seeded.ticketId,
      repositoryId: seeded.repositoryId,
      prUrl: "https://github.com/acme/r/pull/10",
      prNumber: 10,
    });
    return seeded;
  }

  it("una correzione nasce `queued` con le date di default", async () => {
    const { ticketId, repositoryId } = await seedPr();
    const [row] = await db
      .insert(prCorrections)
      .values({ ticketId, repositoryId, prNumber: 10, trigger: "review" })
      .returning();
    expect(row?.status).toBe("queued");
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.providerFeedback).toBeNull();
    // Emendamento E1: una fotografia non letta davvero dal provider non fa da
    // taglio, quindi il default dev'essere `false` (mai `true` per omissione).
    expect(row?.feedbackComplete).toBe(false);
  });

  it("ticket_repositories.prNumber si scrive e si rilegge", async () => {
    const { ticketId, repositoryId } = await seedPr();
    const [row] = await db
      .select({ prNumber: ticketRepositories.prNumber })
      .from(ticketRepositories)
      .where(eq(ticketRepositories.ticketId, ticketId));
    expect(row?.prNumber).toBe(10);
    expect(repositoryId).toBeTruthy();
  });

  it("una sola `pending` e una sola `queued` per PR; `done` senza limite", async () => {
    const { ticketId, repositoryId } = await seedPr();
    const base = { ticketId, repositoryId, prNumber: 10 } as const;
    await db.insert(prCorrections).values({ ...base, trigger: "review", status: "queued" });
    await db.insert(prCorrections).values({ ...base, trigger: "provider", status: "pending" });
    await expectSqlState(
      db.insert(prCorrections).values({ ...base, trigger: "stubwise", status: "queued" }),
      "23505",
    );
    await expectSqlState(
      db.insert(prCorrections).values({ ...base, trigger: "provider", status: "pending" }),
      "23505",
    );
    // Il vincolo è per PR, non per repository: un'altra PR dello stesso repo passa.
    await db.insert(prCorrections).values({ ...base, prNumber: 11, trigger: "review", status: "queued" });
    await db.insert(prCorrections).values({ ...base, trigger: "review", status: "done" });
    await db.insert(prCorrections).values({ ...base, trigger: "review", status: "done" });
  });

  it("i CHECK rifiutano un trigger o uno stato fuori elenco", async () => {
    const { ticketId, repositoryId } = await seedPr();
    await expectSqlState(
      db.execute(sql`
        insert into pr_corrections (ticket_id, repository_id, pr_number, "trigger")
        values (${ticketId}, ${repositoryId}, 10, 'cron')
      `),
      "23514",
    );
    await expectSqlState(
      db.execute(sql`
        insert into pr_corrections (ticket_id, repository_id, pr_number, "trigger", status)
        values (${ticketId}, ${repositoryId}, 10, 'review', 'running')
      `),
      "23514",
    );
  });

  it("un job per correzione (UNIQUE), e cancellare la correzione azzera il legame", async () => {
    const { ticketId, repositoryId } = await seedPr();
    const [c] = await db
      .insert(prCorrections)
      .values({ ticketId, repositoryId, prNumber: 10, trigger: "review" })
      .returning();
    const [job] = await db.insert(aiJobs).values({ ticketId, correctionId: c!.id }).returning();
    await expectSqlState(db.insert(aiJobs).values({ ticketId, correctionId: c!.id }), "23505");
    await db.delete(prCorrections).where(eq(prCorrections.id, c!.id));
    const [after] = await db.select().from(aiJobs).where(eq(aiJobs.id, job!.id));
    expect(after?.correctionId).toBeNull();
  });

  it("projects.prCorrectionMaxRounds: default 3, CHECK 0..10", async () => {
    const { projectId } = await seedPr();
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(p?.prCorrectionMaxRounds).toBe(3);
    // 0 è legittimo: vuol dire ciclo automatico spento.
    await db.update(projects).set({ prCorrectionMaxRounds: 0 }).where(eq(projects.id, projectId));
    await expectSqlState(
      db.update(projects).set({ prCorrectionMaxRounds: -1 }).where(eq(projects.id, projectId)),
      "23514",
    );
    await expectSqlState(
      db.update(projects).set({ prCorrectionMaxRounds: 11 }).where(eq(projects.id, projectId)),
      "23514",
    );
  });

  it("l'account revisore: eliminarlo lascia la repository senza revisore, non la blocca", async () => {
    const { repositoryId } = await seedPr();
    const reviewer = await seedGitAccount(db);
    await db.update(repositories).set({ reviewGitAccountId: reviewer }).where(eq(repositories.id, repositoryId));
    await db.update(gitAccounts).set({ providerUserId: "{uuid-bitbucket}" }).where(eq(gitAccounts.id, reviewer));
    await db.delete(gitAccounts).where(eq(gitAccounts.id, reviewer));
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, repositoryId));
    expect(repo?.reviewGitAccountId).toBeNull();
  });
});
