import { aiJobs, type Db } from "@stubwise/db";
import { seedTicket, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  appendLog,
  claimNextJob,
  completeJob,
  failJob,
  holdJob,
  markFixing,
  parkForPlanApproval,
  requeueStale,
  runWorker,
  touchJob,
  type AiJob,
} from "./queue.js";

// Un container Postgres per file di test: l'avvio costa secondi. I test si
// isolano svuotando la tabella ai_jobs in afterEach (claimNextJob è globale:
// prende il job queued più vecchio dell'intera tabella).
let testDb: TestDb;
let ticketId: string;
let seededProjectId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  const { db } = testDb;
  ({ ticketId, projectId: seededProjectId } = await seedTicket(db));
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(aiJobs);
});

afterAll(async () => {
  await testDb.stop();
});

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface EnqueueOptions {
  createdAt?: Date;
  status?: AiJob["status"];
  startedAt?: Date;
  lastActivityAt?: Date;
}

async function enqueueJob(db: Db, opts: EnqueueOptions = {}): Promise<AiJob> {
  const [job] = await db
    .insert(aiJobs)
    .values({ ticketId, ...opts })
    .returning();
  if (!job) throw new Error("insert del job non ha restituito la riga");
  return job;
}

async function getJob(db: Db, id: string): Promise<AiJob> {
  const [job] = await db.select().from(aiJobs).where(eq(aiJobs.id, id));
  if (!job) throw new Error(`job ${id} non trovato`);
  return job;
}

describe("claimNextJob", () => {
  it("prende il job queued più vecchio e lo marca triaging con startedAt", async () => {
    const { db } = testDb;
    const oldest = await enqueueJob(db, { createdAt: minutesAgo(3) });
    await enqueueJob(db, { createdAt: minutesAgo(2) });
    await enqueueJob(db, { createdAt: minutesAgo(1) });

    const claimed = await claimNextJob(db);

    expect(claimed?.id).toBe(oldest.id);
    expect(claimed?.status).toBe("triaging");
    expect(claimed?.startedAt).not.toBeNull();
    // Il claim è attività: il job parte con l'heartbeat fresco.
    expect(claimed?.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    const persisted = await getJob(db, oldest.id);
    expect(persisted.status).toBe("triaging");
    expect(persisted.startedAt).not.toBeNull();
  });

  it("restituisce null se non ci sono job queued", async () => {
    const { db } = testDb;
    expect(await claimNextJob(db)).toBeNull();

    // Un job già in lavorazione non è reclamabile.
    await enqueueJob(db, { status: "triaging", startedAt: new Date() });
    expect(await claimNextJob(db)).toBeNull();
  });

  it("claim concorrenti non prendono mai lo stesso job", async () => {
    const { db } = testDb;
    await enqueueJob(db, { createdAt: minutesAgo(3) });
    await enqueueJob(db, { createdAt: minutesAgo(2) });
    await enqueueJob(db, { createdAt: minutesAgo(1) });

    const results = await Promise.all([
      claimNextJob(db),
      claimNextJob(db),
      claimNextJob(db),
      claimNextJob(db),
      claimNextJob(db),
    ]);

    const claimed = results.filter((job): job is AiJob => job !== null);
    const nulls = results.filter((job) => job === null);
    expect(claimed).toHaveLength(3);
    expect(nulls).toHaveLength(2);
    expect(new Set(claimed.map((job) => job.id)).size).toBe(3);
  });

  it("excludeProjectIds: salta i job dei progetti esclusi, reclama il primo di un progetto NON escluso", async () => {
    const { db } = testDb;
    // Ticket in un SECONDO progetto (seedTicket crea progetto+repo+ticket).
    const other = await seedTicket(db);
    // Job del progetto condiviso (ticketId globale) — più VECCHIO → normalmente primo.
    const excludedJob = await enqueueJob(db, { createdAt: minutesAgo(5) });
    // Job del secondo progetto — più recente.
    const [otherJob] = await db
      .insert(aiJobs)
      .values({ ticketId: other.ticketId, createdAt: minutesAgo(1) })
      .returning();
    if (!otherJob) throw new Error("insert del job non ha restituito la riga");

    // Escludendo il progetto del job più vecchio, il claim salta a quello dell'altro
    // progetto (nonostante sia più recente).
    const claimed = await claimNextJob(db, [seededProjectId]);
    expect(claimed?.id).toBe(otherJob.id);

    // Senza esclusione, il claim prende il più vecchio (progetto condiviso).
    await db.update(aiJobs).set({ status: "queued", startedAt: null }).where(eq(aiJobs.id, otherJob.id));
    const claimed2 = await claimNextJob(db, []);
    expect(claimed2?.id).toBe(excludedJob.id);
  });
});

describe("transizioni di stato", () => {
  it("completeJob marca pr_opened con prUrl, log e finishedAt", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db);
    await claimNextJob(db);

    const updated = await completeJob(db, job.id, {
      status: "pr_opened",
      log: "PR aperta",
      prUrl: "https://github.com/acme/coda/pull/7",
    });

    expect(updated).toBe(true);
    const persisted = await getJob(db, job.id);
    expect(persisted.status).toBe("pr_opened");
    expect(persisted.prUrl).toBe("https://github.com/acme/coda/pull/7");
    expect(persisted.log).toContain("PR aperta");
    expect(persisted.finishedAt).not.toBeNull();
  });

  it("completeJob marca skipped senza prUrl", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db);
    await claimNextJob(db);

    expect(await completeJob(db, job.id, { status: "skipped", log: "non è un bug fixabile" })).toBe(
      true,
    );

    const persisted = await getJob(db, job.id);
    expect(persisted.status).toBe("skipped");
    expect(persisted.prUrl).toBeNull();
    expect(persisted.finishedAt).not.toBeNull();
  });

  it("failJob marca failed con errore, log e finishedAt", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db);
    await claimNextJob(db);

    const updated = await failJob(db, job.id, {
      log: "stacktrace del fallimento",
      error: "clone fallito",
    });

    expect(updated).toBe(true);
    const persisted = await getJob(db, job.id);
    expect(persisted.status).toBe("failed");
    expect(persisted.error).toBe("clone fallito");
    expect(persisted.log).toContain("stacktrace del fallimento");
    expect(persisted.finishedAt).not.toBeNull();
  });

  it("markFixing porta il job da triaging a fixing", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db);
    await claimNextJob(db);

    expect(await markFixing(db, job.id)).toBe(true);

    const persisted = await getJob(db, job.id);
    expect(persisted.status).toBe("fixing");
    // Anche la transizione è attività: rinfresca l'heartbeat.
    expect(persisted.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("holdJob porta il job da triaging a held, registra finishedAt, held_reason e accoda il log", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db);
    await claimNextJob(db);

    expect(await holdJob(db, job.id, { log: "[triage] in attesa", heldReason: "other" })).toBe(
      true,
    );

    const persisted = await getJob(db, job.id);
    expect(persisted.status).toBe("held");
    expect(persisted.finishedAt).not.toBeNull();
    expect(persisted.log).toContain("[triage] in attesa");
    expect(persisted.heldReason).toBe("other");
  });

  it("holdJob scrive held_reason 'limit' (riaccodabile dal resume poller)", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db);
    await claimNextJob(db);

    expect(
      await holdJob(db, job.id, { log: "[stubwise] provider al limite", heldReason: "limit" }),
    ).toBe(true);

    const persisted = await getJob(db, job.id);
    expect(persisted.status).toBe("held");
    expect(persisted.heldReason).toBe("limit");
  });

  it("parkForPlanApproval porta il job da fixing a awaiting_plan_approval, salva planText e accoda il log SENZA finishedAt", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db, { status: "fixing", startedAt: minutesAgo(1) });

    expect(
      await parkForPlanApproval(db, job.id, { planText: "1. fix A\n2. fix B", log: "[fix] piano pronto" }),
    ).toBe(true);

    const persisted = await getJob(db, job.id);
    expect(persisted.status).toBe("awaiting_plan_approval");
    expect(persisted.planText).toBe("1. fix A\n2. fix B");
    expect(persisted.log).toContain("[fix] piano pronto");
    // Il job è in pausa, non concluso: finishedAt resta NULL.
    expect(persisted.finishedAt).toBeNull();
    // La transizione è attività: rinfresca l'heartbeat.
    expect(persisted.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("parkForPlanApproval su un job non in lavorazione restituisce false e non tocca la riga", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db); // ancora `queued`: nessuno lo possiede

    expect(
      await parkForPlanApproval(db, job.id, { planText: "tardivo", log: "tardivo" }),
    ).toBe(false);

    const persisted = await getJob(db, job.id);
    expect(persisted.status).toBe("queued");
    expect(persisted.planText).toBeNull();
    expect(persisted.log).toBe("");
    expect(persisted.finishedAt).toBeNull();
  });

  it("le transizioni su un job non in lavorazione restituiscono false e non toccano la riga", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db); // ancora `queued`: nessuno lo possiede

    expect(await completeJob(db, job.id, { status: "skipped", log: "tardivo" })).toBe(false);
    expect(await failJob(db, job.id, { log: "tardivo", error: "boom" })).toBe(false);
    expect(await markFixing(db, job.id)).toBe(false);
    expect(await holdJob(db, job.id, { log: "tardivo", heldReason: "other" })).toBe(false);

    const persisted = await getJob(db, job.id);
    expect(persisted.status).toBe("queued");
    expect(persisted.log).toBe("");
    expect(persisted.error).toBeNull();
    expect(persisted.finishedAt).toBeNull();
  });

  it("un handler che ha perso la ownership riceve false e la riga resta del nuovo worker", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db);

    // Il worker A reclama il job ma si blocca senza dare segni di vita...
    await claimNextJob(db);
    await db
      .update(aiJobs)
      .set({ startedAt: minutesAgo(30), lastActivityAt: minutesAgo(30) })
      .where(eq(aiJobs.id, job.id));

    // ...il job viene riportato in coda e reclamato dal worker B, che lo chiude.
    expect(await requeueStale(db, { olderThanMinutes: 10 })).toBe(1);
    const reclaimed = await claimNextJob(db);
    expect(reclaimed?.id).toBe(job.id);
    const completedByB = await completeJob(db, job.id, {
      status: "pr_opened",
      log: "PR aperta da B",
      prUrl: "https://github.com/acme/coda/pull/9",
    });
    expect(completedByB).toBe(true);

    // A si risveglia e prova a chiudere a sua volta: deve ricevere false
    // e la riga (esito di B) non deve essere toccata.
    expect(await completeJob(db, job.id, { status: "skipped", log: "esito tardivo di A" })).toBe(
      false,
    );
    expect(await failJob(db, job.id, { log: "esito tardivo di A", error: "boom" })).toBe(false);
    expect(await markFixing(db, job.id)).toBe(false);

    const persisted = await getJob(db, job.id);
    expect(persisted.status).toBe("pr_opened");
    expect(persisted.prUrl).toBe("https://github.com/acme/coda/pull/9");
    expect(persisted.log).toContain("PR aperta da B");
    expect(persisted.log).not.toContain("esito tardivo di A");
  });

  it("appendLog accoda righe preservando quelle precedenti", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db);

    await appendLog(db, job.id, "prima riga");
    await appendLog(db, job.id, "seconda riga");

    const persisted = await getJob(db, job.id);
    expect(persisted.log).toBe("prima riga\nseconda riga\n");
  });

  it("touchJob rinfresca lastActivityAt senza scrivere nel log (heartbeat silenzioso)", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db, {
      status: "fixing",
      startedAt: minutesAgo(30),
      lastActivityAt: minutesAgo(30),
    });

    await touchJob(db, job.id);

    const persisted = await getJob(db, job.id);
    expect(persisted.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Heartbeat silenzioso: niente rumore nel log a ogni battito.
    expect(persisted.log).toBe("");
  });

  it("appendLog rinfresca lastActivityAt: è l'heartbeat gratuito del worker", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db, {
      status: "fixing",
      startedAt: minutesAgo(30),
      lastActivityAt: minutesAgo(30),
    });

    await appendLog(db, job.id, "ancora al lavoro");

    const persisted = await getJob(db, job.id);
    expect(persisted.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("requeueStale", () => {
  it("riporta in coda solo i job in lavorazione senza attività da troppo tempo", async () => {
    const { db } = testDb;
    const stale = await enqueueJob(db, {
      status: "triaging",
      startedAt: minutesAgo(30),
      lastActivityAt: minutesAgo(30),
    });
    const fresh = await enqueueJob(db, {
      status: "fixing",
      startedAt: minutesAgo(2),
      lastActivityAt: minutesAgo(2),
    });
    const queued = await enqueueJob(db);
    const done = await enqueueJob(db, {
      status: "failed",
      startedAt: minutesAgo(60),
      lastActivityAt: minutesAgo(60),
    });

    const requeued = await requeueStale(db, { olderThanMinutes: 10 });

    expect(requeued).toBe(1);
    const staleAfter = await getJob(db, stale.id);
    expect(staleAfter.status).toBe("queued");
    expect(staleAfter.startedAt).toBeNull();
    expect(staleAfter.log).toContain("riportato in coda");
    expect((await getJob(db, fresh.id)).status).toBe("fixing");
    expect((await getJob(db, queued.id)).status).toBe("queued");
    expect((await getJob(db, done.id)).status).toBe("failed");
  });

  it("un heartbeat touchJob recente tiene il job fuori dal requeue anche oltre la soglia", async () => {
    const { db } = testDb;
    // Fix lungo: startedAt remoto, lastActivityAt remoto... ma l'heartbeat
    // (touchJob) appena fatto lo tiene vivo, anche senza scrivere nel log.
    const longRunning = await enqueueJob(db, {
      status: "fixing",
      startedAt: minutesAgo(120),
      lastActivityAt: minutesAgo(120),
    });
    await touchJob(db, longRunning.id);

    const requeued = await requeueStale(db, { olderThanMinutes: 10 });

    expect(requeued).toBe(0);
    const persisted = await getJob(db, longRunning.id);
    expect(persisted.status).toBe("fixing");
    expect(persisted.startedAt).not.toBeNull();
    expect(persisted.log).not.toContain("riportato in coda");
  });

  it("ignora i job con attività recente anche se startedAt è vecchio", async () => {
    const { db } = testDb;
    // Un fix lungo ma vivo: startedAt remoto, ultimo appendLog appena fatto.
    const longRunning = await enqueueJob(db, {
      status: "fixing",
      startedAt: minutesAgo(120),
      lastActivityAt: minutesAgo(120),
    });
    await appendLog(db, longRunning.id, "compilazione in corso...");

    const requeued = await requeueStale(db, { olderThanMinutes: 10 });

    expect(requeued).toBe(0);
    const persisted = await getJob(db, longRunning.id);
    expect(persisted.status).toBe("fixing");
    expect(persisted.startedAt).not.toBeNull();
    expect(persisted.log).not.toContain("riportato in coda");
  });
});

describe("runWorker", () => {
  it("processa tutti i job rispettando la concorrenza e fallisce quelli con handler in errore", async () => {
    const { db } = testDb;
    const jobs: AiJob[] = [];
    for (let i = 0; i < 5; i += 1) {
      jobs.push(await enqueueJob(db, { createdAt: minutesAgo(5 - i) }));
    }
    const failingId = jobs[2]!.id;

    let active = 0;
    let maxActive = 0;
    const processed = new Set<string>();
    const controller = new AbortController();

    const worker = runWorker({
      db,
      concurrency: 2,
      pollMs: 20,
      signal: controller.signal,
      handler: async (job) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await delay(30);
          processed.add(job.id);
          if (job.id === failingId) throw new Error("boom");
          await completeJob(db, job.id, { status: "skipped", log: "fatto" });
        } finally {
          active -= 1;
        }
      },
    });

    await vi.waitFor(
      () => {
        expect(processed.size).toBe(5);
      },
      { timeout: 15_000 },
    );
    controller.abort();
    await worker;

    expect(maxActive).toBeLessThanOrEqual(2);
    const failed = await getJob(db, failingId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("boom");
    expect(failed.finishedAt).not.toBeNull();
    for (const job of jobs.filter((j) => j.id !== failingId)) {
      expect((await getJob(db, job.id)).status).toBe("skipped");
    }
  }, 30_000);

  it("al boot riporta in coda i job stantii di un worker crashato e li processa", async () => {
    const { db } = testDb;
    const stale = await enqueueJob(db, {
      status: "triaging",
      startedAt: minutesAgo(30),
      lastActivityAt: minutesAgo(30),
    });

    const processed = new Set<string>();
    const controller = new AbortController();
    const worker = runWorker({
      db,
      pollMs: 20,
      staleAfterMinutes: 10,
      signal: controller.signal,
      handler: async (job) => {
        processed.add(job.id);
        await completeJob(db, job.id, { status: "skipped", log: "recuperato" });
      },
    });

    await vi.waitFor(
      () => {
        expect(processed.has(stale.id)).toBe(true);
      },
      { timeout: 15_000 },
    );
    controller.abort();
    await worker;

    expect((await getJob(db, stale.id)).status).toBe("skipped");
  }, 30_000);

  it("l'abort interrompe subito il poll e attende i job in volo", async () => {
    const { db } = testDb;
    const controller = new AbortController();
    const worker = runWorker({
      db,
      // pollMs lungo apposta: se l'abort non interrompesse la sleep, il
      // test andrebbe in timeout.
      pollMs: 60_000,
      signal: controller.signal,
      handler: async () => {},
    });

    await delay(50);
    const before = Date.now();
    controller.abort();
    await worker;
    expect(Date.now() - before).toBeLessThan(2_000);
  }, 10_000);

  it("sopravvive a errori DB transitori con backoff e poi processa i job", async () => {
    const { db } = testDb;
    const job = await enqueueJob(db);

    let claimFailures = 0;
    let requeueFailures = 0;
    const processed = new Set<string>();
    const controller = new AbortController();

    const worker = runWorker({
      db,
      pollMs: 20,
      requeueEveryMs: 1,
      signal: controller.signal,
      handler: async (claimed) => {
        processed.add(claimed.id);
        await completeJob(db, claimed.id, { status: "skipped", log: "fatto" });
      },
      _internals: {
        backoffBaseMs: 10,
        requeueStale: async (database, opts) => {
          if (requeueFailures < 2) {
            requeueFailures += 1;
            throw new Error("DB irraggiungibile (requeue)");
          }
          return requeueStale(database, opts);
        },
        claimNextJob: async (database) => {
          if (claimFailures < 4) {
            claimFailures += 1;
            throw new Error("DB irraggiungibile (claim)");
          }
          return claimNextJob(database);
        },
      },
    });

    await vi.waitFor(
      () => {
        expect(processed.has(job.id)).toBe(true);
      },
      { timeout: 15_000 },
    );
    controller.abort();
    await worker;

    // Il loop ha davvero incassato tutti i fallimenti prima di riuscire.
    expect(requeueFailures).toBe(2);
    expect(claimFailures).toBe(4);
    expect((await getJob(db, job.id)).status).toBe("skipped");
  }, 30_000);
});
