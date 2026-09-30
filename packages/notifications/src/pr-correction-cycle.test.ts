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
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  autoRoundsInCurrentSeries,
  completeCorrection,
  enqueueCorrection,
} from "./pr-correction-cycle.js";

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
    expect(job?.manualTrigger).toBe(true);
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

  it("una CORREZIONE `held` su un'altra PR dello stesso ticket NON blocca (correction_id IS NULL)", async () => {
    // Il controllo della `queued` è per PR, quello del job per TICKET: sulla PR
    // 10 non c'è nessuna `queued`, e il job `held` della correzione sulla PR 11
    // è dello stesso ticket. Solo la clausola `correction_id IS NULL` lo tiene
    // fuori: la sua coda la governa già la sua riga `queued`.
    const pr = await seedPr();
    await seedCorrection({ ...pr, prNumber: 11 }, { trigger: "review", status: "queued", jobStatus: "held" });
    const res = await enqueueCorrection(db, { ...pr, trigger: "stubwise" });
    expect(res).toMatchObject({ ok: true, status: "queued" });
    expect((await correctionsOf(pr)).map((r) => r.status)).toEqual(["queued"]);
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
