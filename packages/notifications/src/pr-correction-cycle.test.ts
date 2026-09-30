import {
  aiJobs,
  prCorrections,
  prReviewJobs,
  prReviews,
  projects,
  users,
  type Db,
} from "@stubwise/db";
import { seedTicket, seedTicketRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AiJobStatus, PrCorrectionTrigger } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autoRoundsInCurrentSeries } from "./pr-correction-cycle.js";

/**
 * Il ciclo di correzione su un Postgres reale (testcontainers), come
 * `project-pulse-summary.test.ts`: la coda si regge su indici unici parziali,
 * lock advisory e transazioni, cioè esattamente ciò che un fake `Db`
 * renderebbe banale da far tornare verde senza che sia vero.
 *
 * Ogni test semina il SUO ticket (progetto e repository nuovi): niente da
 * ripulire fra un test e l'altro.
 */

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb.stop();
});

/** Un istante fisso, `min` minuti dopo le 10:00 del 30 set 2026. */
const at = (min: number) => new Date(Date.UTC(2026, 8, 30, 10, min));

interface SeededPr {
  projectId: string;
  ticketId: string;
  repositoryId: string;
  prNumber: number;
}

/**
 * Un ticket con la sua riga `ticket_repositories`. `prNumber` default 10;
 * `prNumber: null` semina una PR senza numero (riga pre-0081) e il
 * `SeededPr` restituito porta allora 10, il numero su cui i test seminano le
 * correzioni: le correzioni hanno sempre un numero, è la riga del ticket a
 * non averlo.
 */
async function seedPr(
  opts: {
    maxRounds?: number;
    prState?: "open" | "merged" | "closed_unmerged";
    branch?: string;
    prUrl?: string | null;
    prNumber?: number | null;
  } = {},
): Promise<SeededPr> {
  const { projectId, ticketId, repositoryId } = await seedTicket(db);
  if (opts.maxRounds !== undefined) {
    await db
      .update(projects)
      .set({ prCorrectionMaxRounds: opts.maxRounds })
      .where(eq(projects.id, projectId));
  }
  await seedTicketRepository(db, {
    ticketId,
    repositoryId,
    branch: opts.branch ?? "stubwise/ticket-1",
    prUrl: opts.prUrl === undefined ? "https://github.com/acme/r/pull/10" : opts.prUrl,
    prNumber: opts.prNumber === undefined ? 10 : opts.prNumber,
    prState: opts.prState ?? "open",
  });
  return { projectId, ticketId, repositoryId, prNumber: opts.prNumber ?? 10 };
}

async function seedUser(email = `${randomUUID()}@example.com`): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  return row!.id;
}

async function seedCorrection(
  pr: SeededPr,
  opts: {
    trigger: PrCorrectionTrigger;
    status?: "pending" | "queued" | "done" | "cancelled";
    createdAt?: Date;
    requestedByUserId?: string;
    login?: string;
    /** Crea anche il job della correzione, in questo stato. */
    jobStatus?: AiJobStatus;
  },
): Promise<string> {
  const [row] = await db
    .insert(prCorrections)
    .values({
      ticketId: pr.ticketId,
      repositoryId: pr.repositoryId,
      prNumber: pr.prNumber,
      trigger: opts.trigger,
      status: opts.status ?? "done",
      requestedByUserId: opts.requestedByUserId ?? null,
      requestedByProviderLogin: opts.login ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt, updatedAt: opts.createdAt } : {}),
    })
    .returning({ id: prCorrections.id });
  if (opts.jobStatus) {
    await db.insert(aiJobs).values({
      ticketId: pr.ticketId,
      status: opts.jobStatus,
      correctionId: row!.id,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    });
  }
  return row!.id;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- impalcatura dei task A6–A8, che la useranno
async function seedReview(
  pr: SeededPr,
  opts: {
    status: "running" | "completed" | "failed";
    verdict?: "approve" | "request_changes" | null;
    createdAt: Date;
  },
): Promise<string> {
  const [row] = await db
    .insert(prReviews)
    .values({
      repositoryId: pr.repositoryId,
      prNumber: pr.prNumber,
      prUrl: "https://github.com/acme/r/pull/10",
      prTitle: "PR",
      headSha: "abc1234",
      ticketId: pr.ticketId,
      status: opts.status,
      verdict: opts.verdict ?? null,
      createdAt: opts.createdAt,
    })
    .returning({ id: prReviews.id });
  return row!.id;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- impalcatura dei task A6–A8, che la useranno
async function seedReviewJob(pr: SeededPr): Promise<void> {
  await db.insert(prReviewJobs).values({
    repositoryId: pr.repositoryId,
    prNumber: pr.prNumber,
    prUrl: "https://github.com/acme/r/pull/10",
    prTitle: "PR",
    sourceBranch: "stubwise/ticket-1",
    targetBranch: "main",
    headSha: "abc1234",
    notBefore: new Date(),
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- impalcatura dei task A6–A8, che la useranno
async function correctionsOf(pr: SeededPr) {
  return db
    .select()
    .from(prCorrections)
    .where(
      and(
        eq(prCorrections.repositoryId, pr.repositoryId),
        eq(prCorrections.prNumber, pr.prNumber),
      ),
    )
    .orderBy(prCorrections.createdAt);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- impalcatura dei task A6–A8, che la useranno
async function jobsOf(pr: SeededPr) {
  return db.select().from(aiJobs).where(eq(aiJobs.ticketId, pr.ticketId));
}

describe("autoRoundsInCurrentSeries", () => {
  it("nessuna correzione → 0", async () => {
    const pr = await seedPr();
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(0);
  });

  it.each(["stubwise", "provider"] as const)(
    "auto, auto, umana (%s), auto → giro 1: la richiesta umana azzera il contatore",
    async (trigger) => {
      const pr = await seedPr();
      await seedCorrection(pr, { trigger: "review", createdAt: at(1) });
      await seedCorrection(pr, { trigger: "review", createdAt: at(2) });
      await seedCorrection(pr, {
        trigger,
        ...(trigger === "provider" ? { login: "mario" } : { requestedByUserId: await seedUser() }),
        createdAt: at(3),
      });
      await seedCorrection(pr, { trigger: "review", createdAt: at(4) });
      expect(await autoRoundsInCurrentSeries(db, pr)).toBe(1);
    },
  );

  it("umana e automatica allo stesso istante: l'automatica conta come PRECEDENTE", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", createdAt: at(1) });
    await seedCorrection(pr, { trigger: "stubwise", createdAt: at(2) });
    await seedCorrection(pr, { trigger: "review", createdAt: at(2) });
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(0);
  });

  it("senza richieste umane conta tutte le automatiche", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", createdAt: at(1) });
    await seedCorrection(pr, { trigger: "review", createdAt: at(2) });
    await seedCorrection(pr, { trigger: "review", status: "queued", createdAt: at(3) });
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(3);
  });

  it("l'umana annullata non azzera", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", createdAt: at(1) });
    await seedCorrection(pr, { trigger: "stubwise", status: "cancelled", createdAt: at(2) });
    await seedCorrection(pr, { trigger: "review", createdAt: at(3) });
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(2);
  });

  it("l'automatica annullata non conta", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", createdAt: at(1) });
    await seedCorrection(pr, { trigger: "review", status: "cancelled", createdAt: at(2) });
    await seedCorrection(pr, { trigger: "review", createdAt: at(3) });
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(2);
  });

  it("una richiesta umana ancora `pending` azzera già: la tornata nuova è cominciata", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", createdAt: at(1) });
    await seedCorrection(pr, { trigger: "review", status: "queued", createdAt: at(2) });
    await seedCorrection(pr, { trigger: "provider", status: "pending", login: "m", createdAt: at(3) });
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(0);
  });

  it("guarda solo la SUA PR: un'altra PR della stessa repository non conta né azzera", async () => {
    const pr = await seedPr();
    await seedCorrection({ ...pr, prNumber: 11 }, { trigger: "review", createdAt: at(1) });
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(0);
    await seedCorrection(pr, { trigger: "review", createdAt: at(2) });
    await seedCorrection({ ...pr, prNumber: 11 }, { trigger: "provider", login: "m", createdAt: at(3) });
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(1);
  });

  it("altra repository, stesso numero di PR → 0", async () => {
    const pr = await seedPr();
    const other = await seedPr();
    await seedCorrection(other, { trigger: "review", createdAt: at(1) });
    expect(other.prNumber).toBe(pr.prNumber);
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(0);
  });

  it("stessa PR con un ticket diverso: conta, il perimetro è la PR", async () => {
    const pr = await seedPr();
    const { ticketId } = await seedTicket(db, {
      number: 2,
      projectId: pr.projectId,
      repositoryId: pr.repositoryId,
    });
    await seedCorrection({ ...pr, ticketId }, { trigger: "review", createdAt: at(1) });
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(1);
  });
});
