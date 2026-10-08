import {
  aiJobs,
  prCorrections,
  ticketRepositories,
  prReviewJobs,
  prReviews,
  projects,
  repositories,
  users,
  type Db,
} from "@stubwise/db";
import {
  seedRepositoryInProject,
  seedTicket,
  seedTicketRepository,
  startTestDb,
  type TestDb,
} from "@stubwise/db/testing";
import {
  aiJobStatusSchema,
  prCycleSchema,
  type AiJobStatus,
  type PrCorrectionTrigger,
} from "@stubwise/shared";
import { IN_FLIGHT_JOB_STATUSES } from "./actions.js";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  autoRoundsInCurrentSeries,
  cancelOpenCorrections,
  reopenPrRows,
  releaseAdoptionsOnPrClose,
  cancelPendingCorrection,
  canResumeCorrection,
  completeCorrection,
  correctionManualTrigger,
  derivePrCycle,
  enqueueCorrection,
  prHasOpenCorrection,
  promotePendingCorrection,
  promotePendingForTicket,
  promoteStalePendings,
  reconcileOrphanCorrections,
  resolvePrCycleState,
  REDELIVERY_WINDOW_MINUTES,
  TERMINAL_JOB_STATUSES,
  type PrCycleFacts,
} from "./pr-correction-cycle.js";
import { WEBHOOK_REVIEW_BODY_ID } from "./pr-correction-feedback.js";

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
    /** Adozione (6 ott 2026): adottata (e, con `released`, poi rilasciata). */
    adopted?: boolean;
    released?: boolean;
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
    adoptedAt: opts.adopted ? at(0) : null,
    adoptionReleasedAt: opts.adopted && opts.released ? at(1) : null,
  });
  return { projectId, ticketId, repositoryId, prNumber: opts.prNumber ?? 10 };
}

/**
 * Una SECONDA PR dello stesso ticket, su un altro repository del progetto
 * (un ticket multi-repo ha una PR per repo): numero 20, per non confonderla
 * con la 10 di `seedPr`.
 */
async function seedSecondPr(first: SeededPr): Promise<SeededPr> {
  const repositoryId = await seedRepositoryInProject(db, first.projectId);
  await seedTicketRepository(db, {
    ticketId: first.ticketId,
    repositoryId,
    prUrl: "https://github.com/acme/r2/pull/20",
    prNumber: 20,
    prState: "open",
  });
  return { ...first, repositoryId, prNumber: 20 };
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

async function seedReview(
  pr: SeededPr,
  opts: {
    status: "running" | "completed" | "failed";
    verdict?: "approve" | "request_changes" | null;
    createdAt: Date;
    /** Assente = la riga resta IN ATTESA (`started_at` null), come al claim. */
    startedAt?: Date;
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
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
    })
    .returning({ id: prReviews.id });
  return row!.id;
}

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

describe("enqueueCorrection", () => {
  it("niente in volo → correzione `queued` + job che salta il triage", async () => {
    const pr = await seedPr();
    const userId = await seedUser();
    const res = await enqueueCorrection(db, {
      ...pr,
      trigger: "stubwise",
      requestedByUserId: userId,
      actorRole: "admin",
      note: "rinomina la funzione",
    });
    expect(res).toMatchObject({ ok: true, status: "queued" });
    if (!res.ok) throw new Error("atteso ok");
    const [c] = await correctionsOf(pr);
    expect(c).toMatchObject({ id: res.correctionId, status: "queued", note: "rinomina la funzione" });
    const [job] = await jobsOf(pr);
    expect(job).toMatchObject({
      id: res.jobId,
      status: "queued",
      correctionId: res.correctionId,
      requestedByUserId: userId,
      manualTrigger: true,
      planApprovalRequired: false,
      resumeMode: null,
      planText: null,
    });
  });

  it("trigger `review` → job SENZA manualTrigger: il budget mensile ferma il ciclo automatico", async () => {
    const pr = await seedPr();
    const res = await enqueueCorrection(db, { ...pr, trigger: "review" });
    if (!res.ok) throw new Error("atteso ok");
    const [job] = await jobsOf(pr);
    expect(job?.manualTrigger).toBe(false);
  });

  it("senza reviewId prende l'ultima review completata della PR", async () => {
    const pr = await seedPr();
    await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(1) });
    const ultima = await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(2) });
    await seedReview(pr, { status: "failed", createdAt: at(3) });
    await enqueueCorrection(db, { ...pr, trigger: "stubwise" });
    const [c] = await correctionsOf(pr);
    expect(c?.reviewId).toBe(ultima);
  });

  it("bottone con una correzione in corso → correction_in_flight, NESSUNA riga scritta", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "fixing" });
    const res = await enqueueCorrection(db, { ...pr, trigger: "stubwise" });
    expect(res).toEqual({ ok: false, error: "correction_in_flight" });
    expect(await correctionsOf(pr)).toHaveLength(1);
    expect(await jobsOf(pr)).toHaveLength(1);
  });

  it("bottone con un fix in volo sul ticket → job_in_flight, nessuna riga", async () => {
    const pr = await seedPr();
    await db.insert(aiJobs).values({ ticketId: pr.ticketId, status: "fixing" });
    const res = await enqueueCorrection(db, { ...pr, trigger: "stubwise" });
    expect(res).toEqual({ ok: false, error: "job_in_flight" });
    expect(await correctionsOf(pr)).toHaveLength(0);
  });

  it("review con una correzione in corso → correction_in_flight, nessuna riga", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "stubwise", status: "queued", jobStatus: "fixing" });
    const res = await enqueueCorrection(db, { ...pr, trigger: "review" });
    expect(res).toEqual({ ok: false, error: "correction_in_flight" });
    expect(await correctionsOf(pr)).toHaveLength(1);
  });

  it("Request changes durante una correzione → `pending`, senza job", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "fixing", createdAt: at(1) });
    const res = await enqueueCorrection(db, {
      ...pr,
      trigger: "provider",
      requestedByProviderLogin: "mario.rossi",
      providerFeedback: [
        { id: "1", authorId: "{m}", authorLogin: "mario.rossi", body: "no", createdAt: "2026-09-30T10:05:00Z", path: null, line: null },
      ],
    });
    expect(res).toMatchObject({ ok: true, status: "pending", jobId: null });
    const rows = await correctionsOf(pr);
    expect(rows.map((r) => r.status)).toEqual(["queued", "pending"]);
    expect(await jobsOf(pr)).toHaveLength(1);
  });

  it("due Request changes in attesa si FONDONO nella stessa `pending`", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "fixing" });
    const primo = await enqueueCorrection(db, { ...pr, trigger: "provider", requestedByProviderLogin: "anna" });
    const secondo = await enqueueCorrection(db, { ...pr, trigger: "provider", requestedByProviderLogin: "mario" });
    if (!primo.ok || !secondo.ok) throw new Error("attesi ok");
    expect(secondo.correctionId).toBe(primo.correctionId);
    const pending = (await correctionsOf(pr)).filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestedByProviderLogin).toBe("mario");
  });

  it("review con una `pending` e niente in volo → parte la pending, non una correzione automatica", async () => {
    const pr = await seedPr();
    const pendingId = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "mario" });
    const res = await enqueueCorrection(db, { ...pr, trigger: "review" });
    expect(res).toMatchObject({ ok: true, status: "queued", correctionId: pendingId });
    const rows = await correctionsOf(pr);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", trigger: "provider" });
    const [job] = await jobsOf(pr);
    expect(job?.correctionId).toBe(pendingId);
    // D-D2a: un "Request changes" della piattaforma NON scavalca il budget,
    // nemmeno quando a farlo partire è la review.
    expect(job?.manualTrigger).toBe(false);
  });

  it("due click contemporanei → una correzione sola (lock advisory sul ticket)", async () => {
    const pr = await seedPr();
    // Pool CALDO, apposta: con una connessione sola aperta il secondo `begin`
    // ne deve aprire una nuova, e nel frattempo la prima transazione è già
    // finita — le due non si sovrappongono mai e il test resterebbe verde anche
    // senza il lock (verificato). Con le connessioni già pronte si sovrappongono
    // davvero: senza il lock il secondo esplode con un 23505 dell'indice unico
    // sulla `queued` invece di rispondere `correction_in_flight`.
    await Promise.all(Array.from({ length: 4 }, () => db.execute(sql`select pg_sleep(0.05)`)));
    const [a, b] = await Promise.all([
      enqueueCorrection(db, { ...pr, trigger: "stubwise" }),
      enqueueCorrection(db, { ...pr, trigger: "stubwise" }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(await correctionsOf(pr)).toHaveLength(1);
    expect(await jobsOf(pr)).toHaveLength(1);
  });
});

/** Un commento del provider con quel `id` e quel testo. */
const comment = (id: string, body: string) => ({
  id,
  authorId: "{m}",
  authorLogin: "mario.rossi",
  body,
  createdAt: "2026-09-30T10:05:00Z",
  path: null,
  line: null,
});

describe("enqueueCorrection — la PR deve essere ancora aperta (riletta sotto il lock)", () => {
  it.each(["stubwise", "provider", "review"] as const)(
    "trigger %s su una PR non più aperta → pr_not_open, niente scritto",
    async (trigger) => {
      for (const prState of ["merged", "closed_unmerged"] as const) {
        const pr = await seedPr({ prState });
        const res = await enqueueCorrection(db, { ...pr, trigger });
        expect(res).toEqual({ ok: false, error: "pr_not_open" });
        expect(await correctionsOf(pr)).toEqual([]);
        expect(await jobsOf(pr)).toEqual([]);
      }
    },
  );

  it("la riga del ticket porta ora una PR NUOVA: la vecchia non si corregge più", async () => {
    const pr = await seedPr();
    await db
      .update(ticketRepositories)
      .set({ prNumber: 11, prUrl: "https://github.com/acme/r/pull/11" })
      .where(eq(ticketRepositories.ticketId, pr.ticketId));
    expect(await enqueueCorrection(db, { ...pr, trigger: "stubwise" })).toEqual({ ok: false, error: "pr_not_open" });
  });

  it("riga storica senza pr_number: il numero dall'URL", async () => {
    const pr = await seedPr({ prNumber: null });
    expect(await enqueueCorrection(db, { ...pr, trigger: "stubwise" })).toMatchObject({ ok: true, status: "queued" });
  });
});

describe("enqueueCorrection — regole della revisione", () => {
  it("click fuso in una pending provider → la riga promossa resta provider e tiene il login", async () => {
    const pr = await seedPr();
    const userId = await seedUser();
    const pendingId = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "mario" });
    await db
      .update(prCorrections)
      .set({ providerFeedback: [comment("1", "no")] })
      .where(eq(prCorrections.id, pendingId));
    const res = await enqueueCorrection(db, {
      ...pr,
      trigger: "stubwise",
      requestedByUserId: userId,
      actorRole: "admin",
      note: "e rinomina la funzione",
    });
    expect(res).toMatchObject({ ok: true, status: "queued", correctionId: pendingId });
    const rows = await correctionsOf(pr);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "queued",
      trigger: "provider",
      requestedByProviderLogin: "mario",
      requestedByUserId: userId,
      note: "e rinomina la funzione",
      providerFeedback: [comment("1", "no")],
    });
    // La riga resta `provider`, ma a premere è stato un ADMIN col bottone di
    // Stubwise: decide l'attore, non il trigger della riga (D4b).
    const [job] = await jobsOf(pr);
    expect(job).toMatchObject({ correctionId: pendingId, manualTrigger: true });
  });

  it("un FIX parcheggiato in `held` blocca: click → job_in_flight, Request changes → pending", async () => {
    const pr = await seedPr();
    await db.insert(aiJobs).values({ ticketId: pr.ticketId, status: "held" });
    const click = await enqueueCorrection(db, { ...pr, trigger: "stubwise" });
    expect(click).toEqual({ ok: false, error: "job_in_flight" });
    expect(await correctionsOf(pr)).toHaveLength(0);
    const provider = await enqueueCorrection(db, { ...pr, trigger: "provider", requestedByProviderLogin: "anna" });
    expect(provider).toMatchObject({ ok: true, status: "pending", jobId: null });
    expect((await correctionsOf(pr)).map((r) => r.status)).toEqual(["pending"]);
    expect(await jobsOf(pr)).toHaveLength(1);
  });

  it("una CORREZIONE in `held` decide con la sua `queued` → correction_in_flight", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "held" });
    const res = await enqueueCorrection(db, { ...pr, trigger: "stubwise" });
    expect(res).toEqual({ ok: false, error: "correction_in_flight" });
    expect(await correctionsOf(pr)).toHaveLength(1);
  });

  it("una CORREZIONE `held` su un'altra PR dello stesso ticket BLOCCA: un lavoro per ticket", async () => {
    // CAMBIATO nella seconda revisione di A7. Prima una correzione `held` era
    // esclusa da `jobBlocksCorrection` (`correction_id IS NULL`) e qui la PR 10
    // partiva: ma la sua `queued` blocca solo la PR 11, e al risveglio del job
    // `held` ci sarebbero state due correzioni in volo sullo stesso ticket. Ora
    // `held` di QUALUNQUE tipo blocca: click → job_in_flight, Request changes →
    // pending.
    const pr = await seedPr();
    await seedCorrection({ ...pr, prNumber: 11 }, { trigger: "review", status: "queued", jobStatus: "held" });
    const click = await enqueueCorrection(db, { ...pr, trigger: "stubwise" });
    expect(click).toEqual({ ok: false, error: "job_in_flight" });
    expect(await correctionsOf(pr)).toHaveLength(0);
    const provider = await enqueueCorrection(db, { ...pr, trigger: "provider", requestedByProviderLogin: "anna" });
    expect(provider).toMatchObject({ ok: true, status: "pending", jobId: null });
    expect((await correctionsOf(pr)).map((r) => r.status)).toEqual(["pending"]);
  });

  it("due Request changes fusi UNISCONO i commenti, deduplicando per id", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "fixing" });
    await enqueueCorrection(db, {
      ...pr,
      trigger: "provider",
      requestedByProviderLogin: "anna",
      providerFeedback: [comment("1", "uno"), comment("2", "due")],
    });
    await enqueueCorrection(db, {
      ...pr,
      trigger: "provider",
      requestedByProviderLogin: "mario",
      providerFeedback: [comment("2", "due, modificato"), comment("3", "tre")],
    });
    const [pending] = (await correctionsOf(pr)).filter((r) => r.status === "pending");
    expect(pending?.providerFeedback).toEqual([
      comment("1", "uno"),
      comment("2", "due, modificato"),
      comment("3", "tre"),
    ]);
    expect(pending?.requestedByProviderLogin).toBe("mario");
  });

  it("il lock advisory del ticket SERIALIZZA davvero (deterministico): aspetta, poi vede il fix", async () => {
    const pr = await seedPr();
    let pending: ReturnType<typeof enqueueCorrection> | undefined;
    await db.transaction(async (tx) => {
      // 1. il lock lo tiene un altro (qui: noi, a mano, come farebbe startRun)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${pr.ticketId}))`);
      // 2. la correzione parte senza await: deve fermarsi sul lock
      pending = enqueueCorrection(db, { ...pr, trigger: "stubwise" });
      // 3. prova che è davvero in ATTESA sul lock advisory, non già passata
      const deadline = Date.now() + 5000;
      for (;;) {
        const waiting = await db.execute(
          sql`select 1 from pg_stat_activity
              where datname = current_database()
                and wait_event_type = 'Lock' and wait_event = 'advisory'`,
        );
        if (waiting.length > 0) break;
        if (Date.now() > deadline) {
          throw new Error("enqueueCorrection non si è mai fermata sul lock advisory del ticket");
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      // 4. mentre aspetta, chi tiene il lock avvia un fix; poi COMMIT
      await tx.insert(aiJobs).values({ ticketId: pr.ticketId, status: "fixing" });
    });
    // 5. entrata dopo il commit, la correzione vede il fix e rifiuta
    expect(await pending).toEqual({ ok: false, error: "job_in_flight" });
    expect(await correctionsOf(pr)).toHaveLength(0);
  });
});

describe("completeCorrection", () => {
  it("queued → done una volta sola; una cancelled resta cancelled", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "review", status: "queued" });
    expect(await completeCorrection(db, id)).toBe(true);
    expect(await completeCorrection(db, id)).toBe(false);
    const annullata = await seedCorrection(pr, { trigger: "review", status: "cancelled" });
    expect(await completeCorrection(db, annullata)).toBe(false);
    const rows = await correctionsOf(pr);
    expect(rows.map((r) => r.status).sort()).toEqual(["cancelled", "done"]);
  });
});

describe("promotePendingCorrection", () => {
  it("nessuna pending → null", async () => {
    const pr = await seedPr();
    expect(await promotePendingCorrection(db, pr)).toBeNull();
  });

  it("la correzione in corso non è ancora `done` → null, niente cambia", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "fixing", createdAt: at(1) });
    const pendingId = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "m", createdAt: at(2) });
    expect(await promotePendingCorrection(db, pr)).toBeNull();
    const rows = await correctionsOf(pr);
    expect(rows.find((r) => r.id === pendingId)?.status).toBe("pending");
  });

  it("una `queued` blocca da sola, anche senza nessun job che blocchi sul ticket", async () => {
    // Una `queued` senza job (dato anomalo, ma possibile: il job cancellato
    // porta `correction_id` a NULL): nessun job blocca, ed è SOLO la `queued`
    // a tenere ferma la pending. Con un job `held` il test non distinguerebbe
    // più: dalla seconda revisione di A7 `held` blocca comunque.
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "queued", createdAt: at(1) });
    const pendingId = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "m", createdAt: at(2) });
    expect(await promotePendingCorrection(db, pr)).toBeNull();
    const rows = await correctionsOf(pr);
    expect(rows.find((r) => r.id === pendingId)?.status).toBe("pending");
    expect((await jobsOf(pr)).filter((j) => j.status === "queued")).toHaveLength(0);
  });

  it("dopo completeCorrection la pending parte: queued + job", async () => {
    const pr = await seedPr();
    await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(0) });
    const ultima = await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(3) });
    await seedReview(pr, { status: "failed", createdAt: at(4) });
    const inCorso = await seedCorrection(pr, { trigger: "review", status: "queued", createdAt: at(1) });
    await db.insert(aiJobs).values({ ticketId: pr.ticketId, status: "pr_opened", correctionId: inCorso });
    const pendingId = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "m", createdAt: at(2) });
    await completeCorrection(db, inCorso);
    expect(await promotePendingCorrection(db, pr)).toBe(pendingId);
    const rows = await correctionsOf(pr);
    expect(rows.map((r) => r.status)).toEqual(["done", "queued"]);
    // La review agganciata alla promozione è l'ultima COMPLETATA, non l'ultima in assoluto.
    expect(rows.find((r) => r.id === pendingId)?.reviewId).toBe(ultima);
    const jobs = await jobsOf(pr);
    const job = jobs.find((j) => j.correctionId === pendingId);
    expect(job?.status).toBe("queued");
    // D-D2a: una richiesta dalla PIATTAFORMA (chiunque con scrittura sul
    // repository, anche senza ruoli in Stubwise) rispetta budget e gate.
    expect(job?.manualTrigger).toBe(false);
  });

  it("un job ancora in volo sul ticket → null (un job vivo per ticket)", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "provider", status: "pending", login: "m" });
    await db.insert(aiJobs).values({ ticketId: pr.ticketId, status: "fixing" });
    expect(await promotePendingCorrection(db, pr)).toBeNull();
    expect((await correctionsOf(pr))[0]?.status).toBe("pending");
  });
});

describe("promotePendingCorrection — confini", () => {
  it("un job vivo su un ALTRO ticket non blocca la promozione", async () => {
    const pr = await seedPr();
    const pendingId = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "m" });
    const altro = await seedPr();
    await db.insert(aiJobs).values({ ticketId: altro.ticketId, status: "fixing" });
    expect(await promotePendingCorrection(db, pr)).toBe(pendingId);
  });

  it("promuovere la PR B non tocca la pending della PR A", async () => {
    const prA = await seedPr();
    const prB = await seedSecondPr(prA);
    const pendingA = await seedCorrection(prA, { trigger: "provider", status: "pending", login: "m" });
    expect(await promotePendingCorrection(db, prB)).toBeNull();
    expect((await correctionsOf(prA)).find((r) => r.id === pendingA)?.status).toBe("pending");
    expect(await jobsOf(prA)).toHaveLength(0);
  });
});

describe("promotePendingForTicket", () => {
  it("due PR sullo stesso ticket, pending solo su B → parte B", async () => {
    const prA = await seedPr();
    const prB = await seedSecondPr(prA);
    const pendingB = await seedCorrection(prB, { trigger: "provider", status: "pending", login: "m" });
    expect(await promotePendingForTicket(db, prA.ticketId)).toEqual([pendingB]);
    expect((await correctionsOf(prB)).find((r) => r.id === pendingB)?.status).toBe("queued");
    expect((await jobsOf(prB)).find((j) => j.correctionId === pendingB)?.status).toBe("queued");
  });

  it("con un job vivo sul ticket non promuove niente", async () => {
    const prA = await seedPr();
    const prB = await seedSecondPr(prA);
    const pendingA = await seedCorrection(prA, { trigger: "provider", status: "pending", login: "m" });
    const pendingB = await seedCorrection(prB, { trigger: "provider", status: "pending", login: "n" });
    await db.insert(aiJobs).values({ ticketId: prA.ticketId, status: "fixing" });
    expect(await promotePendingForTicket(db, prA.ticketId)).toEqual([]);
    const statuses = [...(await correctionsOf(prA)), ...(await correctionsOf(prB))]
      .filter((r) => r.id === pendingA || r.id === pendingB)
      .map((r) => r.status);
    expect(statuses).toEqual(["pending", "pending"]);
  });
});

describe("promoteStalePendings", () => {
  // Il DB è condiviso fra i test del file: la rete di sicurezza è GLOBALE e può
  // promuovere anche pending lasciate da test precedenti. Si asserisce quindi
  // sulle righe di QUESTO test (`toContain`/`not.toContain`), mai sull'elenco intero.

  it("una pending orfana (nessun job, nessun evento) viene promossa", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "m" });
    expect(await promoteStalePendings(db)).toContain(id);
    expect((await correctionsOf(pr))[0]?.status).toBe("queued");
    expect((await jobsOf(pr)).find((j) => j.correctionId === id)?.status).toBe("queued");
  });

  it("una pending su un ticket con un FIX `held` non si tocca", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "m" });
    await db.insert(aiJobs).values({ ticketId: pr.ticketId, status: "held" });
    expect(await promoteStalePendings(db)).not.toContain(id);
    expect((await correctionsOf(pr))[0]?.status).toBe("pending");
  });

  it("una CORREZIONE `held` sulla PR A blocca la pending della PR B dello stesso ticket", async () => {
    // Senza questa regola il tick farebbe partire B, e al risveglio di A ci
    // sarebbero due correzioni in volo sullo stesso ticket.
    const prA = await seedPr();
    const prB = await seedSecondPr(prA);
    await seedCorrection(prA, { trigger: "review", status: "queued", jobStatus: "held" });
    const id = await seedCorrection(prB, { trigger: "provider", status: "pending", login: "m" });
    expect(await promoteStalePendings(db)).not.toContain(id);
    expect((await correctionsOf(prB))[0]?.status).toBe("pending");
  });

  it("una pending su un ticket con un job `fixing` non si tocca", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "m" });
    await db.insert(aiJobs).values({ ticketId: pr.ticketId, status: "fixing" });
    expect(await promoteStalePendings(db)).not.toContain(id);
    expect((await correctionsOf(pr))[0]?.status).toBe("pending");
  });

  it("best-effort per riga: una promozione che fallisce non ferma le altre", async () => {
    // Un job terminale che punta GIÀ alla pending (dato sporco): la promozione
    // prova a creare il job e viola l'unique su `ai_jobs.correction_id`.
    const rotta = await seedPr();
    const idRotta = await seedCorrection(rotta, {
      trigger: "provider",
      status: "pending",
      login: "m",
      jobStatus: "failed",
    });
    const sana = await seedPr();
    const idSana = await seedCorrection(sana, { trigger: "provider", status: "pending", login: "n" });
    const failed: string[] = [];
    const promoted = await promoteStalePendings(db, { onError: (pendingId) => failed.push(pendingId) });
    expect(promoted).toContain(idSana);
    expect(promoted).not.toContain(idRotta);
    // L'errore arriva al chiamante con l'id della pending, per il warn una-tantum.
    expect(failed).toContain(idRotta);
    expect((await correctionsOf(rotta))[0]?.status).toBe("pending");
  });
});

describe("reconcileOrphanCorrections", () => {
  // DB condiviso e rete GLOBALE, come per promoteStalePendings: si asserisce
  // sulle righe di QUESTO test (`toContain`/`not.toContain`).

  it("PARTIZIONE: ogni stato di un job è terminale OPPURE blocca, mai entrambi né nessuno", () => {
    // Uno stato nuovo dell'enum fa diventare rosso questo test finché non lo
    // si mette esplicitamente da una parte: mai terminale per default.
    const blocking: readonly string[] = [...IN_FLIGHT_JOB_STATUSES, "held"];
    const terminal: readonly string[] = TERMINAL_JOB_STATUSES;
    for (const status of aiJobStatusSchema.options) {
      const places = Number(terminal.includes(status)) + Number(blocking.includes(status));
      expect({ status, places }).toEqual({ status, places: 1 });
    }
  });

  for (const jobStatus of ["failed", "skipped", "pr_opened", "pr_merged", "pr_closed"] as const) {
    it(`job \`${jobStatus}\` con la correzione ancora \`queued\` → done, con una riga nel log del job`, async () => {
      const pr = await seedPr();
      const id = await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus });
      expect(await reconcileOrphanCorrections(db)).toContain(id);
      expect((await correctionsOf(pr))[0]?.status).toBe("done");
      const job = (await jobsOf(pr)).find((j) => j.correctionId === id);
      // Il job non si tocca, se non per la riga di log.
      expect(job?.status).toBe(jobStatus);
      expect(job?.log).toContain(
        `[correction] correzione chiusa dalla riconciliazione: il job era ${jobStatus}\n`,
      );
    });
  }

  it("correzione `queued` SENZA job → done", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "stubwise", status: "queued" });
    expect(await reconcileOrphanCorrections(db)).toContain(id);
    expect((await correctionsOf(pr))[0]?.status).toBe("done");
    expect(await jobsOf(pr)).toHaveLength(0);
  });

  for (const jobStatus of [
    "queued",
    "triaging",
    "fixing",
    "awaiting_plan_approval",
    "awaiting_input",
    "held",
  ] as const) {
    it(`job \`${jobStatus}\` (vivo o parcheggiato) → correzione intatta, log intatto`, async () => {
      const pr = await seedPr();
      const id = await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus });
      expect(await reconcileOrphanCorrections(db)).not.toContain(id);
      expect((await correctionsOf(pr))[0]?.status).toBe("queued");
      expect((await jobsOf(pr)).find((j) => j.correctionId === id)?.log).not.toContain(
        "riconciliazione",
      );
    });
  }

  for (const status of ["pending", "done", "cancelled"] as const) {
    it(`correzione \`${status}\` con job terminale → intatta`, async () => {
      const pr = await seedPr();
      const id = await seedCorrection(pr, {
        trigger: "provider",
        login: "m",
        status,
        jobStatus: "failed",
      });
      expect(await reconcileOrphanCorrections(db)).not.toContain(id);
      expect((await correctionsOf(pr))[0]?.status).toBe(status);
    });
  }

  it("best-effort per riga: una riconciliazione che fallisce non ferma le altre", async () => {
    const rotta = await seedPr();
    const idRotta = await seedCorrection(rotta, { trigger: "review", status: "queued", jobStatus: "failed" });
    const sana = await seedPr();
    const idSana = await seedCorrection(sana, { trigger: "review", status: "queued", jobStatus: "failed" });
    // Un trigger che fa fallire l'UPDATE della sola riga "rotta": l'errore
    // nasce DENTRO la transazione per riga, come un guasto vero.
    await db.execute(
      sql.raw(`create or replace function pr_corr_boom() returns trigger language plpgsql as $$
        begin if old.id = '${idRotta}' then raise exception 'boom'; end if; return new; end $$;`),
    );
    await db.execute(
      sql.raw(`create trigger pr_corr_boom before update on pr_corrections
        for each row execute function pr_corr_boom();`),
    );
    try {
      const failed: string[] = [];
      const done = await reconcileOrphanCorrections(db, { onError: (id) => failed.push(id) });
      expect(done).toContain(idSana);
      expect(done).not.toContain(idRotta);
      expect(failed).toContain(idRotta);
      expect((await correctionsOf(rotta))[0]?.status).toBe("queued");
      expect((await correctionsOf(sana))[0]?.status).toBe("done");
      // Il rollback della transazione per riga toglie anche la riga di log.
      expect((await jobsOf(rotta))[0]?.log).not.toContain("riconciliazione");
    } finally {
      await db.execute(sql.raw("drop trigger pr_corr_boom on pr_corrections"));
      await db.execute(sql.raw("drop function pr_corr_boom()"));
    }
  });

  /**
   * Tiene il lock del ticket, avvia la riconciliazione senza await, aspetta che
   * sia DAVVERO ferma sul lock advisory, esegue `meanwhile` e poi fa COMMIT:
   * lo stesso schema deterministico del test del lock di `enqueueCorrection`.
   */
  async function reconcileWhileLocked(
    ticketId: string,
    meanwhile: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<void>,
  ): Promise<string[]> {
    let running: Promise<string[]> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ticketId}))`);
      running = reconcileOrphanCorrections(db);
      const deadline = Date.now() + 5000;
      for (;;) {
        const waiting = await db.execute(
          sql`select 1 from pg_stat_activity
              where datname = current_database()
                and wait_event_type = 'Lock' and wait_event = 'advisory'`,
        );
        if (waiting.length > 0) break;
        if (Date.now() > deadline) {
          throw new Error("la riconciliazione non si è mai fermata sul lock advisory del ticket");
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      await meanwhile(tx);
    });
    return running!;
  }

  it("sotto il lock RILEGGE il job: ripartito mentre aspettava → correzione intatta", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "failed" });
    const done = await reconcileWhileLocked(pr.ticketId, async (tx) => {
      await tx.update(aiJobs).set({ status: "queued" }).where(eq(aiJobs.correctionId, id));
    });
    expect(done).not.toContain(id);
    expect((await correctionsOf(pr))[0]?.status).toBe("queued");
    expect((await jobsOf(pr))[0]?.log).not.toContain("riconciliazione");
  });

  it("UPDATE guardato: chiusa da completeCorrection mentre aspettava → niente da fare, niente log", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "failed" });
    const done = await reconcileWhileLocked(pr.ticketId, async (tx) => {
      expect(await completeCorrection(tx, id)).toBe(true);
    });
    expect(done).not.toContain(id);
    expect((await correctionsOf(pr))[0]?.status).toBe("done");
    expect((await jobsOf(pr))[0]?.log).not.toContain("riconciliazione");
  });

  it("integrazione: riconciliata l'orfana, promoteStalePendings fa partire la pending della STESSA PR", async () => {
    const pr = await seedPr();
    const orfana = await seedCorrection(pr, {
      trigger: "review",
      status: "queued",
      jobStatus: "failed",
      createdAt: at(1),
    });
    const inAttesa = await seedCorrection(pr, {
      trigger: "provider",
      status: "pending",
      login: "m",
      createdAt: at(2),
    });
    // Senza riconciliazione la `queued` orfana blocca la pending per sempre.
    expect(await promoteStalePendings(db)).not.toContain(inAttesa);
    expect(await reconcileOrphanCorrections(db)).toContain(orfana);
    expect(await promoteStalePendings(db)).toContain(inAttesa);
    const byId = new Map((await correctionsOf(pr)).map((r) => [r.id, r.status]));
    expect(byId.get(orfana)).toBe("done");
    expect(byId.get(inAttesa)).toBe("queued");
    expect((await jobsOf(pr)).find((j) => j.correctionId === inAttesa)?.status).toBe("queued");
  });
});

describe("cancelOpenCorrections", () => {
  it("pending e queued → cancelled; i job non partiti → skipped; il resto non si tocca", async () => {
    const pr = await seedPr();
    const fatta = await seedCorrection(pr, { trigger: "review", status: "done", jobStatus: "pr_opened", createdAt: at(1) });
    const inCoda = await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "queued", createdAt: at(2) });
    const inAttesa = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "m", createdAt: at(3) });
    expect(await cancelOpenCorrections(db, pr)).toEqual([pr.ticketId]);
    const byId = new Map((await correctionsOf(pr)).map((r) => [r.id, r.status]));
    expect(byId.get(fatta)).toBe("done");
    expect(byId.get(inCoda)).toBe("cancelled");
    expect(byId.get(inAttesa)).toBe("cancelled");
    const jobs = await jobsOf(pr);
    expect(jobs.find((j) => j.correctionId === inCoda)?.status).toBe("skipped");
    expect(jobs.find((j) => j.correctionId === fatta)?.status).toBe("pr_opened");
  });

  it("un job già in lavorazione NON viene toccato: sarà il worker a non pushare", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "fixing" });
    expect(await cancelOpenCorrections(db, pr)).toEqual([pr.ticketId]);
    const [job] = await jobsOf(pr);
    expect(job?.status).toBe("fixing");
    expect((await correctionsOf(pr)).find((r) => r.id === id)?.status).toBe("cancelled");
  });

  it("un job parcheggiato `held` (limite/budget) → skipped: il resume poller non deve farlo ripartire", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "held" });
    await cancelOpenCorrections(db, pr);
    const jobs = await jobsOf(pr);
    expect(jobs.find((j) => j.correctionId === id)?.status).toBe("skipped");
  });

  it("niente di aperto → nessun ticket, anche se le correzioni sono solo storiche", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "done", jobStatus: "pr_opened" });
    expect(await cancelOpenCorrections(db, pr)).toEqual([]);
  });

  it("il job annullato riceve una riga nel log", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "queued" });
    await cancelOpenCorrections(db, pr);
    const job = (await jobsOf(pr)).find((j) => j.correctionId === id);
    expect(job?.log).toContain("[correction] PR chiusa: correzione annullata\n");
  });

  // La corsa del webhook di chiusura: un enqueueCorrection ha letto la PR
  // aperta e tiene il lock del ticket con la sua riga non ancora committata;
  // il webhook chiude la riga PR e annulla. Senza `lockTicketIds`
  // l'annullamento non vedrebbe niente da bloccare e la `queued` resterebbe
  // orfana su una PR chiusa.
  it("lockTicketIds: aspetta un accodamento a metà e annulla anche quello", async () => {
    const pr = await seedPr();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let enqueued!: () => void;
    const enqueuedP = new Promise<void>((r) => (enqueued = r));
    const outer = db.transaction(async (tx) => {
      const res = await enqueueCorrection(tx, { ...pr, trigger: "stubwise" });
      expect(res).toMatchObject({ ok: true, status: "queued" });
      enqueued();
      await gate;
    });
    await enqueuedP;
    // Il webhook: prima lo stato della riga (committato), poi l'annullamento.
    await db
      .update(ticketRepositories)
      .set({ prState: "merged" })
      .where(eq(ticketRepositories.ticketId, pr.ticketId));
    const cancelling = cancelOpenCorrections(db, pr, { lockTicketIds: [pr.ticketId] });
    // L'annullamento è fermo sul lock finché l'accodamento non committa.
    await new Promise((r) => setTimeout(r, 100));
    release();
    await outer;
    expect(await cancelling).toEqual([pr.ticketId]);
    const [c] = await correctionsOf(pr);
    expect(c?.status).toBe("cancelled");
    expect((await jobsOf(pr))[0]?.status).toBe("skipped");
  });

  it("chiudere la PR A non tocca le correzioni né i job della PR B dello stesso ticket", async () => {
    const prA = await seedPr();
    const prB = await seedSecondPr(prA);
    await seedCorrection(prA, { trigger: "review", status: "queued", jobStatus: "queued", createdAt: at(1) });
    const queuedB = await seedCorrection(prB, { trigger: "review", status: "queued", jobStatus: "queued", createdAt: at(1) });
    const pendingB = await seedCorrection(prB, { trigger: "provider", status: "pending", login: "m", createdAt: at(2) });
    expect(await cancelOpenCorrections(db, prA)).toEqual([prA.ticketId]);
    const byId = new Map((await correctionsOf(prB)).map((r) => [r.id, r.status]));
    expect(byId.get(queuedB)).toBe("queued");
    expect(byId.get(pendingB)).toBe("pending");
    const jobB = (await jobsOf(prB)).find((j) => j.correctionId === queuedB);
    expect(jobB?.status).toBe("queued");
    expect(jobB?.log).toBe("");
  });
});

describe("prHasOpenCorrection", () => {
  it("pending o queued → true; done e cancelled no; un'altra PR dello stesso ticket non conta", async () => {
    const prA = await seedPr();
    const prB = await seedSecondPr(prA);
    await seedCorrection(prA, { trigger: "review", status: "done" });
    await seedCorrection(prA, { trigger: "review", status: "cancelled" });
    expect(await prHasOpenCorrection(db, prA)).toBe(false);
    await seedCorrection(prB, { trigger: "provider", status: "pending", login: "m" });
    expect(await prHasOpenCorrection(db, prA)).toBe(false);
    expect(await prHasOpenCorrection(db, prB)).toBe(true);
    await seedCorrection(prA, { trigger: "review", status: "queued" });
    expect(await prHasOpenCorrection(db, prA)).toBe(true);
  });
});

describe("enqueueCorrection — giro automatico bloccato da un altro lavoro del ticket", () => {
  it("review bloccata da un job su un'altra PR → pending `review`, senza richiedente", async () => {
    const pr = await seedPr();
    const ultima = await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(1) });
    await seedCorrection({ ...pr, prNumber: 11 }, { trigger: "review", status: "queued", jobStatus: "fixing" });
    // Un chiamante che passasse un richiedente non lo vede scritto: un giro
    // automatico non è la richiesta di nessuno.
    const res = await enqueueCorrection(db, {
      ...pr,
      trigger: "review",
      requestedByUserId: await seedUser(),
      requestedByProviderLogin: "qualcuno",
    });
    expect(res).toMatchObject({ ok: true, status: "pending", jobId: null });
    const [row] = await correctionsOf(pr);
    expect(row).toMatchObject({
      status: "pending",
      trigger: "review",
      reviewId: ultima,
      requestedByUserId: null,
      requestedByProviderLogin: null,
    });
    expect(res.ok && res.correctionId).toBe(row?.id);
  });

  it("poi il lavoro dell'altra PR finisce: promotePendingForTicket la fa partire, job SENZA manualTrigger", async () => {
    const pr = await seedPr();
    const altra = await seedCorrection({ ...pr, prNumber: 11 }, { trigger: "review", status: "queued" });
    const [altraJob] = await db
      .insert(aiJobs)
      .values({ ticketId: pr.ticketId, status: "fixing", correctionId: altra })
      .returning();
    const res = await enqueueCorrection(db, { ...pr, trigger: "review" });
    if (!res.ok) throw new Error("atteso ok");
    // Fine del lavoro dell'altra PR: job terminale, correzione `done`.
    await db.update(aiJobs).set({ status: "pr_opened" }).where(eq(aiJobs.id, altraJob!.id));
    await completeCorrection(db, altra);
    expect(await promotePendingForTicket(db, pr.ticketId)).toEqual([res.correctionId]);
    const [row] = await correctionsOf(pr);
    expect(row).toMatchObject({ status: "queued", trigger: "review" });
    const job = (await jobsOf(pr)).find((j) => j.correctionId === res.correctionId);
    expect(job?.status).toBe("queued");
    // Il giro automatico non scavalca budget e gate, nemmeno dopo l'attesa.
    expect(job?.manualTrigger).toBe(false);
  });

  it("una pending già presente sulla PR: risponde con QUELLA, niente creato né fuso", async () => {
    const pr = await seedPr();
    await seedCorrection({ ...pr, prNumber: 11 }, { trigger: "review", status: "queued", jobStatus: "fixing" });
    const umana = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "anna" });
    const res = await enqueueCorrection(db, { ...pr, trigger: "review" });
    expect(res).toEqual({ ok: true, correctionId: umana, status: "pending", jobId: null });
    const rows = await correctionsOf(pr);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: "provider", requestedByProviderLogin: "anna" });
  });

  it("una `queued` sulla STESSA PR resta correction_in_flight, anche con un job che blocca", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "fixing" });
    const res = await enqueueCorrection(db, { ...pr, trigger: "review" });
    expect(res).toEqual({ ok: false, error: "correction_in_flight" });
    expect(await correctionsOf(pr)).toHaveLength(1);
  });

  it("un click fuso in una pending `review` (senza commenti del provider) ne prende il trigger `stubwise`", async () => {
    const pr = await seedPr();
    const userId = await seedUser();
    const pendingId = await seedCorrection(pr, { trigger: "review", status: "pending" });
    const res = await enqueueCorrection(db, {
      ...pr,
      trigger: "stubwise",
      requestedByUserId: userId,
      actorRole: "admin",
      note: "anche questo",
    });
    expect(res).toMatchObject({ ok: true, status: "queued", correctionId: pendingId });
    const [row] = await correctionsOf(pr);
    expect(row).toMatchObject({ trigger: "stubwise", requestedByUserId: userId, note: "anche questo" });
    // Ora è una richiesta di una persona, e quella persona è un admin: scavalca i tetti.
    expect((await jobsOf(pr))[0]?.manualTrigger).toBe(true);
  });

  it("una pending `review` CONTA come giro della tornata", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "done", createdAt: at(1) });
    await seedCorrection(pr, { trigger: "review", status: "pending", createdAt: at(2) });
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(2);
  });

  it("una pending `review` NON azzera la tornata (solo una persona la azzera)", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "stubwise", status: "done", createdAt: at(1) });
    await seedCorrection(pr, { trigger: "review", status: "done", createdAt: at(2) });
    await seedCorrection(pr, { trigger: "review", status: "done", createdAt: at(3) });
    await seedCorrection(pr, { trigger: "review", status: "pending", createdAt: at(4) });
    // Se la pending azzerasse, conterebbe 1 (solo sé stessa) invece di 3.
    expect(await autoRoundsInCurrentSeries(db, pr)).toBe(3);
  });
});

describe("cancelPendingCorrection", () => {
  it("annulla la pending della PR; la queued e le altre PR non si toccano", async () => {
    const prA = await seedPr();
    const prB = await seedSecondPr(prA);
    const queuedA = await seedCorrection(prA, { trigger: "review", status: "queued", createdAt: at(1) });
    const pendingA = await seedCorrection(prA, { trigger: "provider", status: "pending", login: "m", createdAt: at(2) });
    const pendingB = await seedCorrection(prB, { trigger: "provider", status: "pending", login: "n" });
    expect(await cancelPendingCorrection(db, prA)).toBe(pendingA);
    const byId = new Map([...(await correctionsOf(prA)), ...(await correctionsOf(prB))].map((r) => [r.id, r.status]));
    expect(byId.get(pendingA)).toBe("cancelled");
    expect(byId.get(queuedA)).toBe("queued");
    expect(byId.get(pendingB)).toBe("pending");
  });

  it("niente pending → null", async () => {
    const pr = await seedPr();
    expect(await cancelPendingCorrection(db, pr)).toBeNull();
  });

  it("filtro sul trigger: annulla solo la pending di quel trigger", async () => {
    const pr = await seedPr();
    const auto = await seedCorrection(pr, { trigger: "review", status: "pending" });
    expect(await cancelPendingCorrection(db, pr, { trigger: "review" })).toBe(auto);
    expect(new Map((await correctionsOf(pr)).map((r) => [r.id, r.status])).get(auto)).toBe("cancelled");
  });

  it("filtro sul trigger: una pending UMANA resta intatta → null", async () => {
    const pr = await seedPr();
    const human = await seedCorrection(pr, { trigger: "stubwise", status: "pending" });
    expect(await cancelPendingCorrection(db, pr, { trigger: "review" })).toBeNull();
    expect(new Map((await correctionsOf(pr)).map((r) => [r.id, r.status])).get(human)).toBe("pending");
  });
});

describe("resolvePrCycleState (tabella di verità)", () => {
  const base: PrCycleFacts = {
    prOpen: true,
    correctionQueued: false,
    autoCorrectionPending: false,
    reviewInProgress: false,
    lastCompletedReview: null,
    lastDoneCorrection: null,
    round: 0,
    maxRounds: 3,
  };
  const review = (verdict: "approve" | "request_changes" | null, min = 5) => ({
    verdict,
    createdAt: at(min),
  });

  it.each<[string, Partial<PrCycleFacts>, string]>([
    ["1 correzione in corso vince su tutto", { correctionQueued: true, reviewInProgress: true, lastCompletedReview: review("approve") }, "correcting"],
    ["1b giro automatico in fila (pending `review`) → già correcting", { autoCorrectionPending: true, reviewInProgress: true, lastCompletedReview: review("request_changes") }, "correcting"],
    ["2 review in corso", { reviewInProgress: true, lastCompletedReview: review("approve") }, "reviewing"],
    ["3 correzione fallita dopo l'ultima review", { lastCompletedReview: review("request_changes", 1), lastDoneCorrection: { createdAt: at(2), jobFailed: true } }, "correction_failed"],
    ["4 corretta ma nessuna review della versione nuova", { lastCompletedReview: review("request_changes", 1), lastDoneCorrection: { createdAt: at(2), jobFailed: false } }, "idle"],
    ["5a nessuna review", {}, "idle"],
    ["5b review senza verdetto", { lastCompletedReview: review(null) }, "idle"],
    ["6 approvata", { lastCompletedReview: review("approve") }, "approved"],
    ["6 approvata dopo una correzione (la correzione è PIÙ VECCHIA della review)", { lastCompletedReview: review("approve", 5), lastDoneCorrection: { createdAt: at(2), jobFailed: true } }, "approved"],
    ["7 tetto 0 → modifiche richieste, il ciclo non parte", { lastCompletedReview: review("request_changes"), maxRounds: 0 }, "changes_requested"],
    ["8 al tetto", { lastCompletedReview: review("request_changes"), round: 3 }, "stopped_at_cap"],
    ["8 oltre il tetto (tetto abbassato dopo)", { lastCompletedReview: review("request_changes"), round: 3, maxRounds: 1 }, "stopped_at_cap"],
    ["9 sotto il tetto", { lastCompletedReview: review("request_changes"), round: 1 }, "changes_requested"],
    ["PR chiusa: la correzione in coda non conta più", { prOpen: false, correctionQueued: true, lastCompletedReview: review("approve") }, "approved"],
    ["PR chiusa: il giro automatico in fila non conta più", { prOpen: false, autoCorrectionPending: true, lastCompletedReview: review("approve") }, "approved"],
    ["PR chiusa: la review a metà non conta più", { prOpen: false, reviewInProgress: true }, "idle"],
  ])("%s", (_nome, facts, atteso) => {
    expect(resolvePrCycleState({ ...base, ...facts })).toBe(atteso);
  });
});

describe("derivePrCycle", () => {
  it("null se la PR non è di Stubwise (branch fuori da `stubwise/`)", async () => {
    const pr = await seedPr({ branch: "feature/login" });
    expect(await derivePrCycle(db, pr)).toBeNull();
  });

  it("null anche per un branch `stubwise/*` che non è di un ticket (graphify-setup)", async () => {
    // Il worker apre davvero PR su `stubwise/graphify-setup`: la rotta delle
    // correzioni risponderebbe `not_stubwise_pr`, quindi niente ciclo e niente
    // bottone (un bottone mostrato è un bottone che funziona).
    const pr = await seedPr({ branch: "stubwise/graphify-setup" });
    expect(await derivePrCycle(db, pr)).toBeNull();
  });

  it("null se il branch è di un ALTRO ticket", async () => {
    // seedTicket crea il ticket numero 1
    const pr = await seedPr({ branch: "stubwise/ticket-2" });
    expect(await derivePrCycle(db, pr)).toBeNull();
  });

  it("null se la PR non è ancora aperta (pr_url null)", async () => {
    const pr = await seedPr({ prUrl: null, prNumber: null });
    expect(await derivePrCycle(db, pr)).toBeNull();
  });

  it("pr_number null su una riga scritta da un worker vecchio → lo ricava dall'URL", async () => {
    const pr = await seedPr({ prNumber: null });
    await seedReview(pr, { status: "completed", verdict: "approve", createdAt: at(1) });
    expect((await derivePrCycle(db, pr))?.state).toBe("approved");
  });

  it("pr_number null e URL senza numero → null, mai un numero inventato", async () => {
    const pr = await seedPr({ prNumber: null, prUrl: "https://example.com/qualcosa" });
    expect(await derivePrCycle(db, pr)).toBeNull();
  });

  it("appena aperta, nessuna review → idle, si può chiedere una correzione", async () => {
    const pr = await seedPr();
    expect(await derivePrCycle(db, pr)).toEqual({
      state: "idle",
      round: 0,
      maxRounds: 3,
      pendingRequest: false,
      lastRequest: null,
      canRequestCorrection: true,
      heldReason: null,
      canResume: false,
      heldJobId: null,
      blockedReason: null,
    });
  });

  it("review in coda (pr_review_jobs) → reviewing", async () => {
    const pr = await seedPr();
    await seedReviewJob(pr);
    expect((await derivePrCycle(db, pr))?.state).toBe("reviewing");
  });

  it("review `running` → reviewing; una `failed` più recente non la nasconde", async () => {
    const pr = await seedPr();
    await seedReview(pr, { status: "running", createdAt: at(1) });
    await seedReview(pr, { status: "failed", createdAt: at(2) });
    expect((await derivePrCycle(db, pr))?.state).toBe("reviewing");
  });

  it("review IN ATTESA nel serializer (running, started_at null) → reviewing, non il verdetto precedente", async () => {
    // La finestra del piano (C10): il poller ha già tolto il job da
    // `pr_review_jobs` ma la review non è ancora partita. Nessuna riga in coda,
    // quindi è la sola riga `pr_reviews` in attesa a dire «reviewing» invece
    // del `changes_requested` della review completata prima. Il bottone NON
    // dipende da `reviewing` (è la condizione di `enqueueCorrection`: PR
    // aperta, niente `queued`, niente job): qui resta disponibile.
    const pr = await seedPr();
    await seedReview(pr, {
      status: "completed",
      verdict: "request_changes",
      createdAt: at(1),
      startedAt: at(1),
    });
    await seedReview(pr, { status: "running", createdAt: at(2) });
    expect(await derivePrCycle(db, pr)).toMatchObject({
      state: "reviewing",
      canRequestCorrection: true,
    });
  });

  it("giro 2 di 3 in corso → correcting, round 2, niente bottone", async () => {
    const pr = await seedPr();
    await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(1) });
    await seedCorrection(pr, { trigger: "review", jobStatus: "pr_opened", createdAt: at(2) });
    await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(3) });
    await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "fixing", createdAt: at(4) });
    const cycle = await derivePrCycle(db, pr);
    expect(cycle).toMatchObject({ state: "correcting", round: 2, maxRounds: 3, canRequestCorrection: false });
  });

  it("tre correzioni automatiche e la review chiede ancora → stopped_at_cap", async () => {
    const pr = await seedPr();
    for (let i = 0; i < 3; i++) {
      await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(i * 2) });
      await seedCorrection(pr, { trigger: "review", jobStatus: "pr_opened", createdAt: at(i * 2 + 1) });
    }
    await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(10) });
    expect(await derivePrCycle(db, pr)).toMatchObject({
      state: "stopped_at_cap",
      round: 3,
      canRequestCorrection: true,
    });
  });

  it("Request changes in attesa durante una correzione → pendingRequest e lastRequest dal login", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "fixing", createdAt: at(1) });
    await seedCorrection(pr, { trigger: "provider", status: "pending", login: "mario.rossi", createdAt: at(2) });
    expect(await derivePrCycle(db, pr)).toMatchObject({
      state: "correcting",
      pendingRequest: true,
      round: 0,
      // seedTicket crea repository GitHub (default di `seedRepository`)
      lastRequest: { via: "provider", platform: "github", name: "mario.rossi", at: at(2).toISOString() },
    });
  });

  it("giro automatico in fila (pending `review`, un altro lavoro del ticket blocca) → correcting, NON una richiesta in attesa", async () => {
    // Un fix `held` (limite/budget) sullo stesso ticket: la review ha chiesto
    // modifiche, `enqueueCorrection` ha messo il giro in fila come `pending`
    // `review`. È un giro AUTOMATICO in arrivo, non una persona che aspetta.
    const pr = await seedPr();
    await db.insert(aiJobs).values({ ticketId: pr.ticketId, status: "held" });
    await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(1) });
    await seedCorrection(pr, { trigger: "review", status: "pending", createdAt: at(2) });
    expect(await derivePrCycle(db, pr)).toEqual({
      state: "correcting",
      round: 1,
      maxRounds: 3,
      pendingRequest: false,
      lastRequest: null,
      canRequestCorrection: false,
      // A essere fermo è il FIX, non una correzione: nessun motivo da dire.
      heldReason: null,
      canResume: false,
      heldJobId: null,
      blockedReason: null,
    });
  });

  it("richiesta dal bottone → lastRequest con l'email dell'utente", async () => {
    const pr = await seedPr();
    const userId = await seedUser("anna@example.com");
    await seedCorrection(pr, { trigger: "stubwise", requestedByUserId: userId, jobStatus: "failed", createdAt: at(1) });
    expect(await derivePrCycle(db, pr)).toMatchObject({
      state: "correction_failed",
      lastRequest: { via: "stubwise", platform: null, name: "anna@example.com" },
    });
  });

  it("lastRequest.at di una correzione CHIUSA è l'ora della richiesta, non quella della chiusura", async () => {
    const pr = await seedPr();
    const userId = await seedUser();
    const id = await seedCorrection(pr, { trigger: "stubwise", requestedByUserId: userId, jobStatus: "pr_opened", createdAt: at(1) });
    // completeCorrection sposta updated_at (l'ora del push)
    await db.update(prCorrections).set({ updatedAt: at(9) }).where(eq(prCorrections.id, id));
    expect((await derivePrCycle(db, pr))?.lastRequest?.at).toBe(at(1).toISOString());
  });

  it("lastRequest.at di una PENDING è updated_at (la fusione la rinnova)", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "mario.rossi", createdAt: at(1) });
    await db.update(prCorrections).set({ updatedAt: at(7) }).where(eq(prCorrections.id, id));
    expect((await derivePrCycle(db, pr))?.lastRequest?.at).toBe(at(7).toISOString());
  });

  it("un fix in volo sul ticket toglie il bottone anche senza correzioni", async () => {
    const pr = await seedPr();
    await db.insert(aiJobs).values({ ticketId: pr.ticketId, status: "fixing" });
    expect((await derivePrCycle(db, pr))?.canRequestCorrection).toBe(false);
  });

  it("un job `held` sul ticket toglie il bottone (stessa regola di enqueueCorrection)", async () => {
    // `held` non è in IN_FLIGHT_JOB_STATUSES: se derivePrCycle ricopiasse la
    // regola invece di usare `hasJobInFlight`, il bottone comparirebbe e il
    // click prenderebbe `job_in_flight`.
    const pr = await seedPr();
    await db.insert(aiJobs).values({ ticketId: pr.ticketId, status: "held" });
    expect((await derivePrCycle(db, pr))?.canRequestCorrection).toBe(false);
  });

  it("PR mergiata → niente bottone, lo stato racconta l'ultima review", async () => {
    const pr = await seedPr({ prState: "merged" });
    await seedReview(pr, { status: "completed", verdict: "approve", createdAt: at(1) });
    expect(await derivePrCycle(db, pr)).toMatchObject({ state: "approved", canRequestCorrection: false });
  });

  it("fermo al tetto e tetto abbassato DOPO: round resta il numero vero (3), non il nuovo tetto", async () => {
    const pr = await seedPr();
    for (let i = 0; i < 3; i++) {
      await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(i * 2) });
      await seedCorrection(pr, { trigger: "review", jobStatus: "pr_opened", createdAt: at(i * 2 + 1) });
    }
    await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(10) });
    await db.update(projects).set({ prCorrectionMaxRounds: 1 }).where(eq(projects.id, pr.projectId));
    expect(await derivePrCycle(db, pr)).toMatchObject({ state: "stopped_at_cap", round: 3, maxRounds: 1 });
  });

  it("lastRequest.name, ripiego: `provider` senza login → l'email dell'utente collegato", async () => {
    const pr = await seedPr();
    const userId = await seedUser("collegato@example.com");
    await seedCorrection(pr, { trigger: "provider", status: "pending", requestedByUserId: userId, createdAt: at(1) });
    expect((await derivePrCycle(db, pr))?.lastRequest?.name).toBe("collegato@example.com");
  });

  it("lastRequest.name, ripiego: `stubwise` senza email → il login", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "stubwise", login: "luigi.verdi", jobStatus: "pr_opened", createdAt: at(1) });
    expect((await derivePrCycle(db, pr))?.lastRequest?.name).toBe("luigi.verdi");
  });

  it("lastRequest.name `\"\"` se l'utente è stato cancellato (SET NULL) e non c'è login", async () => {
    const pr = await seedPr();
    const userId = await seedUser();
    await seedCorrection(pr, { trigger: "stubwise", requestedByUserId: userId, jobStatus: "pr_opened", createdAt: at(1) });
    await db.delete(users).where(eq(users.id, userId));
    expect((await derivePrCycle(db, pr))?.lastRequest).toMatchObject({ via: "stubwise", name: "" });
  });

  it("contratto: l'uscita passa da prCycleSchema identica (lastRequest valorizzato)", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "provider", status: "pending", login: "mario.rossi", createdAt: at(1) });
    const cycle = await derivePrCycle(db, pr);
    expect(cycle?.lastRequest).not.toBeNull();
    expect(prCycleSchema.parse(cycle)).toEqual(cycle);
  });

  it("contratto: l'uscita passa da prCycleSchema identica (lastRequest null)", async () => {
    const pr = await seedPr();
    const cycle = await derivePrCycle(db, pr);
    expect(cycle?.lastRequest).toBeNull();
    expect(prCycleSchema.parse(cycle)).toEqual(cycle);
  });

  it("il tetto è quello del progetto", async () => {
    const pr = await seedPr({ maxRounds: 0 });
    await seedReview(pr, { status: "completed", verdict: "request_changes", createdAt: at(1) });
    expect(await derivePrCycle(db, pr)).toMatchObject({ state: "changes_requested", maxRounds: 0 });
  });
});

describe("D4b — manualTrigger lo decide CHI AGISCE: solo un admin scavalca budget e gate", () => {
  it("Request changes con niente in volo → `queued`, job SENZA manualTrigger", async () => {
    const pr = await seedPr();
    const res = await enqueueCorrection(db, { ...pr, trigger: "provider", requestedByProviderLogin: "estraneo" });
    expect(res).toMatchObject({ ok: true, status: "queued" });
    const [job] = await jobsOf(pr);
    expect(job?.manualTrigger).toBe(false);
  });

  it("stessi dati, due ruoli: il bottone di un ADMIN → manualTrigger, quello di un MEMBER → no", async () => {
    for (const [role, expected] of [
      ["admin", true],
      ["member", false],
    ] as const) {
      const pr = await seedPr();
      const res = await enqueueCorrection(db, { ...pr, trigger: "stubwise", actorRole: role });
      expect(res).toMatchObject({ ok: true, status: "queued" });
      const [job] = await jobsOf(pr);
      // Un member ottiene la correzione, senza gate del piano: solo il budget lo ferma.
      expect(job).toMatchObject({ manualTrigger: expected, planApprovalRequired: false });
    }
  });

  it("il bottone SENZA attore (chiamante che non lo passa) → nessun manualTrigger: il trigger `stubwise` non basta", async () => {
    const pr = await seedPr();
    await enqueueCorrection(db, { ...pr, trigger: "stubwise" });
    const [job] = await jobsOf(pr);
    expect(job?.manualTrigger).toBe(false);
  });

  it("click di un member fuso in una pending provider → promossa SENZA manualTrigger", async () => {
    const pr = await seedPr();
    const pendingId = await seedCorrection(pr, { trigger: "provider", status: "pending", login: "mario" });
    const res = await enqueueCorrection(db, { ...pr, trigger: "stubwise", actorRole: "member" });
    expect(res).toMatchObject({ ok: true, status: "queued", correctionId: pendingId });
    const [job] = await jobsOf(pr);
    expect(job?.manualTrigger).toBe(false);
  });

  it("promozione senza attore (fine lavoro, tick) di una pending `stubwise` → SENZA manualTrigger", async () => {
    // Prima di D4b il trigger della riga bastava: ora nessuno sta agendo.
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "stubwise", status: "pending" });
    await promotePendingCorrection(db, pr);
    const [job] = await jobsOf(pr);
    expect(job?.manualTrigger).toBe(false);
  });

  it("una richiesta dalla piattaforma che fa partire una pending `review` → SENZA manualTrigger", async () => {
    const pr = await seedPr();
    const pendingId = await seedCorrection(pr, { trigger: "review", status: "pending" });
    const res = await enqueueCorrection(db, { ...pr, trigger: "provider", requestedByProviderLogin: "anna" });
    expect(res).toMatchObject({ ok: true, status: "queued", correctionId: pendingId });
    const [job] = await jobsOf(pr);
    expect(job?.manualTrigger).toBe(false);
  });

  it("correctionManualTrigger: vero SOLO per admin", () => {
    expect(correctionManualTrigger("admin")).toBe(true);
    expect(correctionManualTrigger("member")).toBe(false);
    expect(correctionManualTrigger(null)).toBe(false);
    expect(correctionManualTrigger(undefined)).toBe(false);
  });
});

describe("D4b — canResume: chi guarda può riprendere la correzione ferma (col SUO ruolo)", () => {
  async function heldCorrection(reason: "budget" | "limit" | "other") {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "provider", status: "queued", login: "anna", jobStatus: "queued" });
    await db.update(aiJobs).set({ status: "held", heldReason: reason }).where(eq(aiJobs.correctionId, id));
    return pr;
  }

  it("stessi dati, due ruoli: ferma per BUDGET → l'admin la riprende, il member no", async () => {
    const pr = await heldCorrection("budget");
    const admin = await derivePrCycle(db, { ...pr, viewerRole: "admin" });
    const member = await derivePrCycle(db, { ...pr, viewerRole: "member" });
    expect(admin).toMatchObject({ state: "correcting", heldReason: "budget", canResume: true });
    expect(member).toMatchObject({ state: "correcting", heldReason: "budget", canResume: false });
    expect(prCycleSchema.parse(admin)).toEqual(admin);
  });

  it("stessi dati, due ruoli: ferma per LIMITE → entrambi la riprendono", async () => {
    const pr = await heldCorrection("limit");
    expect((await derivePrCycle(db, { ...pr, viewerRole: "admin" }))?.canResume).toBe(true);
    expect((await derivePrCycle(db, { ...pr, viewerRole: "member" }))?.canResume).toBe(true);
  });

  it("heldJobId: l'id del job FERMO della correzione, per chiunque guardi; null quando niente è fermo", async () => {
    const pr = await heldCorrection("budget");
    const [job] = await jobsOf(pr);
    expect(job?.status).toBe("held");
    expect((await derivePrCycle(db, { ...pr, viewerRole: "admin" }))?.heldJobId).toBe(job!.id);
    // Anche a chi non può riprenderla: è un'identità, non un permesso.
    expect((await derivePrCycle(db, { ...pr, viewerRole: "member" }))?.heldJobId).toBe(job!.id);

    const running = await seedPr();
    await seedCorrection(running, { trigger: "provider", status: "queued", login: "anna", jobStatus: "fixing" });
    expect((await derivePrCycle(db, { ...running, viewerRole: "admin" }))?.heldJobId).toBeNull();
  });

  it("senza viewerRole vale il più restrittivo (member)", async () => {
    const pr = await heldCorrection("budget");
    expect((await derivePrCycle(db, pr))?.canResume).toBe(false);
  });

  it("niente di fermo → canResume false anche per un admin", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "provider", status: "queued", login: "anna", jobStatus: "fixing" });
    expect((await derivePrCycle(db, { ...pr, viewerRole: "admin" }))?.canResume).toBe(false);
  });

  it("canResumeCorrection, la tabella intera", () => {
    expect(canResumeCorrection(null, "admin")).toBe(false);
    expect(canResumeCorrection("budget", "admin")).toBe(true);
    expect(canResumeCorrection("budget", "member")).toBe(false);
    for (const r of ["limit", "other"] as const) {
      expect(canResumeCorrection(r, "admin")).toBe(true);
      expect(canResumeCorrection(r, "member")).toBe(true);
    }
  });
});

describe("D-D2a — derivePrCycle dice perché la correzione è ferma", () => {
  async function holdJobOf(correctionId: string, reason: "budget" | "limit" | "other" | null) {
    await db.update(aiJobs).set({ status: "held", heldReason: reason }).where(eq(aiJobs.correctionId, correctionId));
  }

  it("correzione `queued` col job `held` per budget → correcting, heldReason budget", async () => {
    const pr = await seedPr();
    const id = await seedCorrection(pr, { trigger: "provider", status: "queued", login: "anna", jobStatus: "queued" });
    await holdJobOf(id, "budget");
    const cycle = await derivePrCycle(db, pr);
    expect(cycle).toMatchObject({ state: "correcting", heldReason: "budget" });
    expect(prCycleSchema.parse(cycle)).toEqual(cycle);
  });

  it("i motivi sono quelli di `ai_jobs.held_reason`; un `held` senza motivo → other", async () => {
    for (const [reason, expected] of [
      ["limit", "limit"],
      ["other", "other"],
      [null, "other"],
    ] as const) {
      const pr = await seedPr();
      const id = await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "queued" });
      await holdJobOf(id, reason);
      expect((await derivePrCycle(db, pr))?.heldReason).toBe(expected);
    }
  });

  it("job della correzione ATTIVO → heldReason null", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "provider", status: "queued", login: "anna", jobStatus: "fixing" });
    expect(await derivePrCycle(db, pr)).toMatchObject({ state: "correcting", heldReason: null });
  });

  it("PR chiusa con una correzione ancora `queued` e job `held` → heldReason null (non è `correcting`)", async () => {
    const pr = await seedPr({ prState: "merged" });
    const id = await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "queued" });
    await holdJobOf(id, "budget");
    const cycle = await derivePrCycle(db, pr);
    expect(cycle?.state).not.toBe("correcting");
    expect(cycle?.heldReason).toBeNull();
  });
});

describe("D-D2b — una riconsegna non diventa una seconda correzione", () => {
  /** La voce del webhook col testo della review, come la scrive D2. */
  const reviewBody = (body: string, authorId = "{m}") => ({
    id: WEBHOOK_REVIEW_BODY_ID,
    authorId,
    authorLogin: "mario.rossi",
    body,
    createdAt: "2026-09-30T10:05:00Z",
    path: null,
    line: null,
  });

  async function queuedFromProvider(pr: SeededPr, feedback: ReturnType<typeof reviewBody>[]) {
    const res = await enqueueCorrection(db, {
      ...pr,
      trigger: "provider",
      requestedByProviderLogin: "mario.rossi",
      providerFeedback: feedback,
    });
    if (!res.ok || res.status !== "queued") throw new Error("attesa una queued");
    return res;
  }

  it("due consegne identiche (la seconda con id di commenti diversi) → UNA correzione, la stessa risposta", async () => {
    const pr = await seedPr();
    const first = await queuedFromProvider(pr, [reviewBody("rinomina la funzione"), { ...reviewBody("x"), id: "c-1" }]);
    const second = await enqueueCorrection(db, {
      ...pr,
      trigger: "provider",
      requestedByProviderLogin: "mario.rossi",
      // spazi ai bordi diversi, commenti con id diversi: è la stessa richiesta
      providerFeedback: [reviewBody("  rinomina la funzione\n"), { ...reviewBody("y"), id: "c-2" }],
    });
    expect(second).toEqual({ ok: true, correctionId: first.correctionId, status: "queued", jobId: first.jobId });
    const rows = await correctionsOf(pr);
    expect(rows).toHaveLength(1);
    // Niente scritto: la fotografia è quella della prima consegna.
    expect(rows[0]?.providerFeedback).toEqual([reviewBody("rinomina la funzione"), { ...reviewBody("x"), id: "c-1" }]);
    expect(await jobsOf(pr)).toHaveLength(1);
  });

  it("Bitbucket: entrambe SENZA voce del webhook → la stessa richiesta", async () => {
    const pr = await seedPr();
    const first = await queuedFromProvider(pr, []);
    const second = await enqueueCorrection(db, { ...pr, trigger: "provider", requestedByProviderLogin: "mario.rossi", providerFeedback: [] });
    expect(second).toMatchObject({ ok: true, correctionId: first.correctionId, status: "queued" });
    expect(await correctionsOf(pr)).toHaveLength(1);
  });

  it("GitHub, la correzione è già partita: la voce `review-<id>` del worker vale come la stessa voce", async () => {
    const pr = await seedPr();
    const first = await queuedFromProvider(pr, [reviewBody("rinomina")]);
    // C8 ha rifatto la fotografia: la voce del webhook è diventata `review-<id>`.
    await db
      .update(prCorrections)
      .set({ providerFeedback: [{ ...reviewBody("rinomina"), id: "review-77" }] })
      .where(eq(prCorrections.id, first.correctionId));
    const second = await enqueueCorrection(db, {
      ...pr,
      trigger: "provider",
      requestedByProviderLogin: "mario.rossi",
      providerFeedback: [reviewBody("rinomina")],
    });
    expect(second).toMatchObject({ ok: true, correctionId: first.correctionId, status: "queued" });
    expect(await correctionsOf(pr)).toHaveLength(1);
  });

  it("`review-<id>` di un ALTRO autore con lo stesso testo → richiesta nuova (pending)", async () => {
    const pr = await seedPr();
    const first = await queuedFromProvider(pr, [reviewBody("rinomina")]);
    await db
      .update(prCorrections)
      .set({ providerFeedback: [{ ...reviewBody("rinomina", "{altro}"), id: "review-77" }] })
      .where(eq(prCorrections.id, first.correctionId));
    const second = await enqueueCorrection(db, {
      ...pr,
      trigger: "provider",
      requestedByProviderLogin: "mario.rossi",
      providerFeedback: [reviewBody("rinomina")],
    });
    expect(second).toMatchObject({ ok: true, status: "pending" });
  });

  it("login diverso → pending", async () => {
    const pr = await seedPr();
    await queuedFromProvider(pr, [reviewBody("rinomina")]);
    const second = await enqueueCorrection(db, {
      ...pr,
      trigger: "provider",
      requestedByProviderLogin: "anna",
      providerFeedback: [reviewBody("rinomina")],
    });
    expect(second).toMatchObject({ ok: true, status: "pending", jobId: null });
    expect((await correctionsOf(pr)).map((r) => r.status)).toEqual(["queued", "pending"]);
  });

  it("testo diverso → pending", async () => {
    const pr = await seedPr();
    await queuedFromProvider(pr, [reviewBody("rinomina")]);
    const second = await enqueueCorrection(db, {
      ...pr,
      trigger: "provider",
      requestedByProviderLogin: "mario.rossi",
      providerFeedback: [reviewBody("e aggiungi un test")],
    });
    expect(second).toMatchObject({ ok: true, status: "pending" });
  });

  it("voce presente da una parte sola → pending", async () => {
    const pr = await seedPr();
    await queuedFromProvider(pr, []);
    const second = await enqueueCorrection(db, {
      ...pr,
      trigger: "provider",
      requestedByProviderLogin: "mario.rossi",
      providerFeedback: [reviewBody("rinomina")],
    });
    expect(second).toMatchObject({ ok: true, status: "pending" });
  });

  it(`oltre ${REDELIVERY_WINDOW_MINUTES} minuti → pending (la stessa persona la sta chiedendo di nuovo)`, async () => {
    const pr = await seedPr();
    const first = await queuedFromProvider(pr, [reviewBody("rinomina")]);
    await db
      .update(prCorrections)
      .set({ createdAt: sql`now() - make_interval(mins => ${REDELIVERY_WINDOW_MINUTES + 1})` })
      .where(eq(prCorrections.id, first.correctionId));
    const second = await enqueueCorrection(db, {
      ...pr,
      trigger: "provider",
      requestedByProviderLogin: "mario.rossi",
      providerFeedback: [reviewBody("rinomina")],
    });
    expect(second).toMatchObject({ ok: true, status: "pending" });
  });

  it("la `queued` è del bottone (stesso login assente) → non è una riconsegna", async () => {
    const pr = await seedPr();
    await enqueueCorrection(db, { ...pr, trigger: "stubwise" });
    const second = await enqueueCorrection(db, { ...pr, trigger: "provider", providerFeedback: [] });
    expect(second).toMatchObject({ ok: true, status: "pending" });
  });

  it("pending: fondere la STESSA voce due volte non la duplica (dedup per id della fotografia)", async () => {
    const pr = await seedPr();
    await seedCorrection(pr, { trigger: "review", status: "queued", jobStatus: "fixing" });
    for (let i = 0; i < 2; i++) {
      await enqueueCorrection(db, {
        ...pr,
        trigger: "provider",
        requestedByProviderLogin: "mario.rossi",
        providerFeedback: [reviewBody("rinomina")],
      });
    }
    const pending = (await correctionsOf(pr)).filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.providerFeedback).toEqual([reviewBody("rinomina")]);
  });
});


describe("adozione di una PR aperta da altri (6 ott 2026) — la regola unica nel ciclo", () => {
  it("una PR adottata e non rilasciata ha il ciclo, anche col branch di una persona", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true });
    // Visto da un admin: su una PR adottata «Chiedi modifiche» è suo (7 ott 2026).
    expect(await derivePrCycle(db, { ...pr, viewerRole: "admin" })).toMatchObject({
      state: "idle",
      canRequestCorrection: true,
    });
  });

  it("rilasciata: niente ciclo, niente bottone", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true, released: true });
    expect(await derivePrCycle(db, pr)).toBeNull();
  });

  it("enqueueCorrection su una PR adottata accoda la correzione col suo job", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true });
    expect(await enqueueCorrection(db, { ...pr, trigger: "stubwise", actorRole: "admin" })).toMatchObject({
      ok: true,
      status: "queued",
    });
    expect(await correctionsOf(pr)).toHaveLength(1);
    expect(await jobsOf(pr)).toHaveLength(1);
  });

  it.each(["stubwise", "provider", "review"] as const)(
    "trigger %s su una PR rilasciata (o mai adottata) → pr_not_correctable, niente scritto",
    async (trigger) => {
      for (const opts of [{ adopted: true, released: true }, {}]) {
        const pr = await seedPr({ branch: "feature/login", ...opts });
        expect(await enqueueCorrection(db, { ...pr, trigger })).toEqual({ ok: false, error: "pr_not_correctable" });
        expect(await correctionsOf(pr)).toEqual([]);
        expect(await jobsOf(pr)).toEqual([]);
      }
    },
  );

  it("cancelOpenCorrections scrive la riga di log del chiamante sul job annullato", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true });
    await seedCorrection(pr, { trigger: "stubwise", status: "queued", jobStatus: "queued" });
    await cancelOpenCorrections(db, pr, { logLine: "[correction] adozione rilasciata\n" });
    const [job] = await jobsOf(pr);
    expect(job!.status).toBe("skipped");
    expect(job!.log).toContain("adozione rilasciata");
    expect(job!.log).not.toContain("PR chiusa");
  });
});

describe("adozione e chiusura della PR (6 ott 2026, fix di review)", () => {
  it("releaseAdoptionsOnPrClose rilascia la riga adottata della PR, e solo quella", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true });
    const other = await seedPr({ branch: "feature/x", adopted: true, prNumber: 11 });
    expect(await releaseAdoptionsOnPrClose(db, pr)).toEqual([pr.ticketId]);
    const [row] = await db.select().from(ticketRepositories).where(eq(ticketRepositories.ticketId, pr.ticketId));
    expect(row!.adoptionReleasedAt).not.toBeNull();
    const [untouched] = await db.select().from(ticketRepositories).where(eq(ticketRepositories.ticketId, other.ticketId));
    expect(untouched!.adoptionReleasedAt).toBeNull();
    // Idempotente.
    expect(await releaseAdoptionsOnPrClose(db, pr)).toEqual([]);
  });

  it("reopenPrRows NON riapre una riga adottata e non rilasciata (difesa in profondità)", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true, prState: "closed_unmerged" });
    expect(await reopenPrRows(db, pr)).toEqual(new Set());
    const [row] = await db.select().from(ticketRepositories).where(eq(ticketRepositories.ticketId, pr.ticketId));
    expect(row!.prState).toBe("closed_unmerged");
  });

  it("…ma riapre una riga adottata e GIÀ rilasciata (non correggibile: serve un'adozione nuova)", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true, released: true, prState: "closed_unmerged" });
    expect(await reopenPrRows(db, pr)).toEqual(new Set([pr.ticketId]));
    expect(await derivePrCycle(db, pr)).toBeNull();
  });
});

describe("PR ADOTTATA: «Chiedi modifiche» e la ripresa sono di un admin (7 ott 2026)", () => {
  it("stessi dati, due ruoli: canRequestCorrection vero solo per l'admin", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true });
    expect((await derivePrCycle(db, { ...pr, viewerRole: "admin" }))?.canRequestCorrection).toBe(true);
    expect((await derivePrCycle(db, { ...pr, viewerRole: "member" }))?.canRequestCorrection).toBe(false);
  });

  it("su una PR di Stubwise un member continua a poter chiedere modifiche (verso opposto)", async () => {
    const pr = await seedPr();
    expect((await derivePrCycle(db, { ...pr, viewerRole: "member" }))?.canRequestCorrection).toBe(true);
  });

  it("correzione ferma (limite) su una PR adottata: la riprende solo un admin", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true });
    const correctionId = await seedCorrection(pr, { trigger: "stubwise", status: "queued", jobStatus: "held" });
    await db.update(aiJobs).set({ heldReason: "limit" }).where(eq(aiJobs.correctionId, correctionId));
    expect((await derivePrCycle(db, { ...pr, viewerRole: "admin" }))?.canResume).toBe(true);
    expect((await derivePrCycle(db, { ...pr, viewerRole: "member" }))?.canResume).toBe(false);
  });

  it("enqueueCorrection: il click di un member su una PR adottata → forbidden, niente scritto", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true });
    expect(await enqueueCorrection(db, { ...pr, trigger: "stubwise", actorRole: "member" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await correctionsOf(pr)).toEqual([]);
    expect(await jobsOf(pr)).toEqual([]);
    // Il ciclo automatico e la piattaforma non hanno un ruolo: invariati.
    expect(await enqueueCorrection(db, { ...pr, trigger: "review" })).toMatchObject({ ok: true });
  });
});

describe("PR ADOTTATA col branch PROTETTO: niente correzioni, e il ciclo dice perché (7 ott 2026)", () => {
  async function protect(pr: SeededPr, patterns: string[]) {
    await db.update(repositories).set({ protectedBranches: patterns }).where(eq(repositories.id, pr.repositoryId));
  }

  it("derivePrCycle: bottone spento anche per un admin, col motivo", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true });
    await protect(pr, ["feature/*"]);
    expect(await derivePrCycle(db, { ...pr, viewerRole: "admin" })).toMatchObject({
      canRequestCorrection: false,
      blockedReason: "adopted_branch_protected",
    });
  });

  it("derivePrCycle: senza protezione nessun motivo (verso opposto)", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true });
    await protect(pr, ["develop"]);
    expect(await derivePrCycle(db, { ...pr, viewerRole: "admin" })).toMatchObject({
      canRequestCorrection: true,
      blockedReason: null,
    });
  });

  it("correzione ferma: nemmeno un admin la riprende", async () => {
    const pr = await seedPr({ branch: "feature/login", adopted: true });
    const correctionId = await seedCorrection(pr, { trigger: "stubwise", status: "queued", jobStatus: "held" });
    await db.update(aiJobs).set({ heldReason: "limit" }).where(eq(aiJobs.correctionId, correctionId));
    await protect(pr, ["feature/login"]);
    expect((await derivePrCycle(db, { ...pr, viewerRole: "admin" }))?.canResume).toBe(false);
  });

  it.each(["stubwise", "review", "provider"] as const)(
    "enqueueCorrection (%s): rifiutata sotto il lock, zero righe in pr_corrections e ai_jobs",
    async (trigger) => {
      const pr = await seedPr({ branch: "feature/login", adopted: true });
      await protect(pr, ["feature/*"]);
      expect(await enqueueCorrection(db, { ...pr, trigger, actorRole: "admin" })).toEqual({
        ok: false,
        error: "adopted_branch_protected",
      });
      expect(await correctionsOf(pr)).toEqual([]);
      expect(await jobsOf(pr)).toEqual([]);
    },
  );

  it("una PR di Stubwise sul suo branch non è toccata dai protetti (la regola è dell'adozione)", async () => {
    const pr = await seedPr();
    await protect(pr, ["stubwise/*"]);
    expect(await enqueueCorrection(db, { ...pr, trigger: "stubwise", actorRole: "member" })).toMatchObject({ ok: true });
  });
});
