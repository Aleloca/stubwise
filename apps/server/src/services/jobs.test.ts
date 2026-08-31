import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiJobs, comments, instanceSettings, notifications, users, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { t } from "@stubwise/i18n";
import { createTicket } from "../db/tickets.js";
import { IN_FLIGHT, resolvePlan, startRun, type Actor } from "./jobs.js";

let testDb: TestDb;
let db: Db;
/** Progetto in cui nascono tutti i ticket del file. */
let projectId: string;
let maintainer: Actor;
let operator: Actor;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
  maintainer = await seedUser("admin");
  operator = await seedUser("member");
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

/** Inserisce un utente col ruolo dato: serve un id REALE per la FK requested_by_user_id. */
async function seedUser(role: "admin" | "member"): Promise<Actor> {
  const [row] = await db
    .insert(users)
    .values({ email: `${role}-${randomUUID()}@example.com`, passwordHash: "x", role })
    .returning({ id: users.id, role: users.role });
  return { id: row!.id, role: row!.role };
}

/** Crea un ticket nel progetto di test, con `implementationPlan` opzionale. */
async function seedTicket(plan?: string): Promise<string> {
  const ticket = await createTicket(db, {
    projectId,
    title: "Ticket di servizio",
    type: "bug",
    priority: "medium",
    source: "manual",
    ...(plan === undefined ? {} : { implementationPlan: plan }),
  });
  return ticket.id;
}

/** Legge il job per id (comodo per asserire lo stato persistito). */
async function readJob(jobId: string) {
  const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobId));
  return job;
}

/** Commenti del ticket in ordine di inserimento (createdAt, id come spareggio). */
async function readComments(ticketId: string) {
  return db
    .select()
    .from(comments)
    .where(eq(comments.ticketId, ticketId))
    .orderBy(asc(comments.createdAt), asc(comments.id));
}

/** Imposta la lingua dei contenuti dell'istanza (singleton id=1). */
async function setContentLanguage(lang: "en" | "it"): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ id: 1, contentLanguage: lang })
    .onConflictDoUpdate({ target: instanceSettings.id, set: { contentLanguage: lang } });
}

/** Attesa breve, per osservare che una promise sia ancora pendente. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startRun", () => {
  it("ticket inesistente → ticket_not_found", async () => {
    const result = await startRun(db, { ticketId: randomUUID(), actor: maintainer });
    expect(result).toEqual({ ok: false, error: "ticket_not_found" });
  });

  it("admin + piano salvato → job queued in execute diretto, col piano e l'autore", async () => {
    const piano = "## Piano salvato\n1. Passo A";
    const ticketId = await seedTicket(piano);

    const result = await startRun(db, { ticketId, actor: maintainer });
    expect(result).toEqual({ ok: true, jobId: expect.any(String), status: "queued" });

    const job = await readJob(result.ok ? result.jobId : "");
    expect(job?.status).toBe("queued");
    expect(job?.resumeMode).toBe("execute");
    expect(job?.planText).toBe(piano);
    expect(job?.manualTrigger).toBe(true);
    expect(job?.requestedByUserId).toBe(maintainer.id);
    // Il maintainer approva implicitamente lanciando: nessun gate sul piano.
    expect(job?.planApprovalRequired).toBe(false);
  });

  it("member + piano salvato → job parcheggiato in awaiting_plan_approval col piano", async () => {
    const piano = "## Piano dell'operatore\n1. Passo A";
    const ticketId = await seedTicket(piano);

    const result = await startRun(db, { ticketId, actor: operator });
    expect(result).toEqual({
      ok: true,
      jobId: expect.any(String),
      status: "awaiting_plan_approval",
    });

    const job = await readJob(result.ok ? result.jobId : "");
    expect(job?.status).toBe("awaiting_plan_approval");
    expect(job?.planText).toBe(piano);
    expect(job?.resumeMode).toBe("execute");
    expect(job?.manualTrigger).toBe(true);
    expect(job?.requestedByUserId).toBe(operator.id);
    expect(job?.planApprovalRequired).toBe(true);
  });

  it("member senza piano → queued col gate planApprovalRequired acceso", async () => {
    const ticketId = await seedTicket();

    const result = await startRun(db, { ticketId, actor: operator });
    expect(result).toEqual({ ok: true, jobId: expect.any(String), status: "queued" });

    const job = await readJob(result.ok ? result.jobId : "");
    expect(job?.status).toBe("queued");
    expect(job?.planApprovalRequired).toBe(true);
    expect(job?.resumeMode).toBeNull();
    expect(job?.planText).toBeNull();
    expect(job?.requestedByUserId).toBe(operator.id);
  });

  it("member + piano salvato → notifica job.plan_review in inbox all'admin, agganciata al job", async () => {
    const ticketId = await seedTicket("## Piano dell'operatore da approvare");

    const result = await startRun(db, {
      ticketId,
      actor: operator,
      publicUrl: "https://stubwise.example.com",
    });
    expect(result).toEqual({
      ok: true,
      jobId: expect.any(String),
      status: "awaiting_plan_approval",
    });
    const jobId = result.ok ? result.jobId : "";

    // Il parcheggio è la richiesta di approvazione: chi può approvare (admin)
    // se la deve trovare in inbox, agganciata a progetto, ticket e job.
    const rows = await db.select().from(notifications).where(eq(notifications.jobId, jobId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.userId).toBe(maintainer.id);
    expect(row.kind).toBe("job.plan_review");
    expect(row.projectId).toBe(projectId);
    expect(row.ticketId).toBe(ticketId);
    expect(row.event).toMatchObject({
      kind: "job.plan_review",
      ticketUrl: `https://stubwise.example.com/tickets/${ticketId}`,
    });
  });

  it("admin che lancia (nessun parcheggio) → nessuna notifica job.plan_review", async () => {
    const ticketId = await seedTicket("## Piano che parte subito");

    const result = await startRun(db, { ticketId, actor: maintainer });
    expect(result.ok && result.status).toBe("queued");

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.jobId, result.ok ? result.jobId : ""));
    expect(rows).toHaveLength(0);
  });

  it("member + piano salvato + mode:ai_plan → flusso normale queued (il piano non si usa)", async () => {
    const ticketId = await seedTicket("## Piano da NON usare");

    const result = await startRun(db, { ticketId, actor: operator, mode: "ai_plan" });
    expect(result).toEqual({ ok: true, jobId: expect.any(String), status: "queued" });

    const job = await readJob(result.ok ? result.jobId : "");
    expect(job?.resumeMode).toBeNull();
    expect(job?.planText).toBeNull();
    expect(job?.planApprovalRequired).toBe(true);
  });

  it("withInstructions su ticket senza piano → resumeMode=fix", async () => {
    const ticketId = await seedTicket();

    const result = await startRun(db, { ticketId, actor: maintainer, withInstructions: true });
    expect(result.ok).toBe(true);

    const job = await readJob(result.ok ? result.jobId : "");
    expect(job?.resumeMode).toBe("fix");
    expect(job?.planText).toBeNull();
  });

  it("il piano salvato VINCE su withInstructions", async () => {
    const piano = "## Piano che vince";
    const ticketId = await seedTicket(piano);

    const result = await startRun(db, { ticketId, actor: maintainer, withInstructions: true });
    expect(result.ok).toBe(true);

    const job = await readJob(result.ok ? result.jobId : "");
    expect(job?.resumeMode).toBe("execute");
    expect(job?.planText).toBe(piano);
  });

  it.each(IN_FLIGHT)("ultimo job in %s → job_in_flight, e il job NON viene toccato", async (status) => {
    const ticketId = await seedTicket();
    const [existing] = await db
      .insert(aiJobs)
      .values({ ticketId, status, planText: "piano in volo", error: "vecchio errore" })
      .returning();

    const result = await startRun(db, { ticketId, actor: maintainer });
    expect(result).toEqual({ ok: false, error: "job_in_flight", jobStatus: status });

    const job = await readJob(existing!.id);
    expect(job?.status).toBe(status);
    expect(job?.planText).toBe("piano in volo");
    expect(job?.error).toBe("vecchio errore");
    expect(job?.requestedByUserId).toBeNull();
    // Nessun job nuovo accodato accanto a quello in volo.
    const all = await db.select().from(aiJobs).where(eq(aiJobs.ticketId, ticketId));
    expect(all).toHaveLength(1);
  });

  it.each(["held", "failed", "pr_closed", "skipped", "pr_opened", "pr_merged"] as const)(
    "ultimo job in %s → riusa la riga, azzerando started/finished/error",
    async (status) => {
      const ticketId = await seedTicket();
      const [existing] = await db
        .insert(aiJobs)
        .values({
          ticketId,
          status,
          startedAt: new Date(),
          finishedAt: new Date(),
          error: "vecchio errore",
          manualTrigger: false,
          lastActivityAt: new Date(Date.now() - 60_000),
        })
        .returning();

      const result = await startRun(db, { ticketId, actor: maintainer });
      expect(result).toEqual({ ok: true, jobId: existing!.id, status: "queued" });

      const job = await readJob(existing!.id);
      expect(job?.status).toBe("queued");
      expect(job?.manualTrigger).toBe(true);
      expect(job?.startedAt).toBeNull();
      expect(job?.finishedAt).toBeNull();
      expect(job?.error).toBeNull();
      expect(job?.requestedByUserId).toBe(maintainer.id);
      expect(job!.lastActivityAt.getTime()).toBeGreaterThan(existing!.lastActivityAt.getTime());
      // Riuso, non duplicazione.
      const all = await db.select().from(aiJobs).where(eq(aiJobs.ticketId, ticketId));
      expect(all).toHaveLength(1);
    },
  );

  it("due startRun concorrenti su un ticket vergine: UN solo job, l'altro job_in_flight", async () => {
    const ticketId = await seedTicket();

    const results = await Promise.all([
      startRun(db, { ticketId, actor: maintainer }),
      startRun(db, { ticketId, actor: maintainer }),
    ]);

    const started = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);
    expect(started).toHaveLength(1);
    expect(rejected).toEqual([{ ok: false, error: "job_in_flight", jobStatus: "queued" }]);

    const jobs = await db.select().from(aiJobs).where(eq(aiJobs.ticketId, ticketId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("queued");
  });

  it("startRun ATTENDE chi tiene il lock del ticket, poi ne vede il job", async () => {
    const ticketId = await seedTicket();

    // Scrittore concorrente: prende il lock del ticket, accoda un job e tiene
    // la transazione APERTA. È lo scenario che il solo `select` di startRun non
    // vedrebbe (il job non è ancora committato) e che senza lock lo porterebbe
    // ad accodarne un secondo.
    let release!: () => void;
    const holdOpen = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ticketId}))`);
      await tx.insert(aiJobs).values({ ticketId, status: "queued" });
      await holdOpen;
    });

    try {
      const running = startRun(db, { ticketId, actor: maintainer });
      // Finché il writer non committa, startRun deve restare bloccato sul lock.
      const pending = Symbol("pending");
      const raced = await Promise.race([running, delay(250).then(() => pending)]);
      expect(raced).toBe(pending);

      release();
      await writer;

      // Sbloccato, legge lo stato REALE del ticket: c'è già un job in coda.
      await expect(running).resolves.toEqual({
        ok: false,
        error: "job_in_flight",
        jobStatus: "queued",
      });
    } finally {
      release();
      await writer.catch(() => undefined);
    }

    const jobs = await db.select().from(aiJobs).where(eq(aiJobs.ticketId, ticketId));
    expect(jobs).toHaveLength(1);
  });
});

describe("resolvePlan", () => {
  /** Inserisce un job fermo sul gate del piano, con residui da azzerare. */
  async function seedAwaitingJob(ticketId: string, planText = "## Piano proposto\n1. Passo A") {
    const [job] = await db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "awaiting_plan_approval",
        planText,
        startedAt: new Date(),
        finishedAt: new Date(),
        error: "vecchio errore",
        planApprovalRequired: true,
      })
      .returning();
    return job!;
  }

  beforeAll(async () => {
    // Default esplicito: i test sulla lingua impostano il proprio valore.
    await setContentLanguage("en");
  });

  it("member → forbidden, e il job resta fermo sul gate", async () => {
    const ticketId = await seedTicket();
    const job = await seedAwaitingJob(ticketId);

    const result = await resolvePlan(db, { ticketId, actor: operator, mode: "execute" });
    expect(result).toEqual({ ok: false, error: "forbidden" });

    const unchanged = await readJob(job.id);
    expect(unchanged?.status).toBe("awaiting_plan_approval");
    expect(await readComments(ticketId)).toHaveLength(0);
  });

  it("ticket inesistente → ticket_not_found", async () => {
    const result = await resolvePlan(db, {
      ticketId: randomUUID(),
      actor: maintainer,
      mode: "execute",
    });
    expect(result).toEqual({ ok: false, error: "ticket_not_found" });
  });

  it("admin senza job in attesa → plan_not_pending", async () => {
    const ticketId = await seedTicket();
    await db.insert(aiJobs).values({ ticketId, status: "queued" });

    const result = await resolvePlan(db, { ticketId, actor: maintainer, mode: "execute" });
    expect(result).toEqual({ ok: false, error: "plan_not_pending" });
    expect(await readComments(ticketId)).toHaveLength(0);
  });

  it("execute: job queued+execute, piano CONSERVATO, residui azzerati, commento di sistema", async () => {
    const ticketId = await seedTicket();
    const job = await seedAwaitingJob(ticketId);

    const result = await resolvePlan(db, { ticketId, actor: maintainer, mode: "execute" });
    expect(result).toEqual({ ok: true, jobId: job.id });

    const updated = await readJob(job.id);
    expect(updated?.status).toBe("queued");
    expect(updated?.resumeMode).toBe("execute");
    expect(updated?.planText).toBe("## Piano proposto\n1. Passo A");
    expect(updated?.startedAt).toBeNull();
    expect(updated?.finishedAt).toBeNull();
    expect(updated?.error).toBeNull();

    const cmts = await readComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.authorType).toBe("system");
    expect(cmts[0]!.body).toBe(t("en", "comment.planApproved"));
  });

  it("fix: job queued+fix, piano azzerato per la ripianificazione", async () => {
    const ticketId = await seedTicket();
    const job = await seedAwaitingJob(ticketId);

    const result = await resolvePlan(db, { ticketId, actor: maintainer, mode: "fix" });
    expect(result).toEqual({ ok: true, jobId: job.id });

    const updated = await readJob(job.id);
    expect(updated?.status).toBe("queued");
    expect(updated?.resumeMode).toBe("fix");
    expect(updated?.planText).toBeNull();

    const cmts = await readComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.body).toBe(t("en", "comment.planRejected"));
  });

  it("prende l'ultimo job AWAITING anche con un job più recente in altro stato", async () => {
    const ticketId = await seedTicket();
    const awaiting = await seedAwaitingJob(ticketId);
    const [newer] = await db
      .insert(aiJobs)
      .values({
        ticketId,
        status: "failed",
        createdAt: new Date(awaiting.createdAt.getTime() + 60_000),
      })
      .returning();

    const result = await resolvePlan(db, { ticketId, actor: maintainer, mode: "execute" });
    expect(result).toEqual({ ok: true, jobId: awaiting.id });

    // Il job più recente resta intatto.
    const untouched = await readJob(newer!.id);
    expect(untouched?.status).toBe("failed");
  });

  it("con instructions: inserisce il commento del team (autore = admin) prima di quello di sistema", async () => {
    const ticketId = await seedTicket();
    await seedAwaitingJob(ticketId);

    const result = await resolvePlan(db, {
      ticketId,
      actor: maintainer,
      mode: "fix",
      instructions: "Ripianifica senza toccare lo schema del DB.",
    });
    expect(result.ok).toBe(true);

    // Il commento del team è authorType 'user': è esattamente ciò che il
    // re-plan del worker rilegge come "indicazioni del team".
    const cmts = await readComments(ticketId);
    expect(cmts).toHaveLength(2);
    // L'ORDINE conta: la timeline ordina per createdAt, e le istruzioni devono
    // precedere la nota di sistema che le segue.
    expect(cmts.map((c) => c.authorType)).toEqual(["user", "system"]);
    const [team, system] = cmts;
    expect(team!.body).toBe("Ripianifica senza toccare lo schema del DB.");
    expect(team!.authorId).toBe(maintainer.id);
    expect(system!.createdAt.getTime()).toBeGreaterThan(team!.createdAt.getTime());
  });

  it("instructions vuote o solo spazi: nessun commento del team", async () => {
    const ticketId = await seedTicket();
    await seedAwaitingJob(ticketId);

    const result = await resolvePlan(db, {
      ticketId,
      actor: maintainer,
      mode: "fix",
      instructions: "   ",
    });
    expect(result.ok).toBe(true);

    const cmts = await readComments(ticketId);
    expect(cmts).toHaveLength(1);
    expect(cmts[0]!.authorType).toBe("system");
  });

  it("idempotenza: la seconda chiamata → plan_not_pending, un solo commento di sistema", async () => {
    const ticketId = await seedTicket();
    await seedAwaitingJob(ticketId);

    const first = await resolvePlan(db, { ticketId, actor: maintainer, mode: "execute" });
    expect(first.ok).toBe(true);
    const second = await resolvePlan(db, { ticketId, actor: maintainer, mode: "execute" });
    expect(second).toEqual({ ok: false, error: "plan_not_pending" });

    expect(await readComments(ticketId)).toHaveLength(1);
  });

  it("il commento di sistema segue la lingua dei contenuti dell'istanza", async () => {
    await setContentLanguage("it");
    try {
      const ticketId = await seedTicket();
      await seedAwaitingJob(ticketId);

      const result = await resolvePlan(db, { ticketId, actor: maintainer, mode: "execute" });
      expect(result.ok).toBe(true);

      const cmts = await readComments(ticketId);
      expect(cmts[0]!.body).toBe(t("it", "comment.planApproved"));
      expect(cmts[0]!.body).toMatch(/approvat/i);
    } finally {
      await setContentLanguage("en");
    }
  });
});
