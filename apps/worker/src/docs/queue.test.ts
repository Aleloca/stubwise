import { docGenerationJobs, docGenerations, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  appendDocJobLog,
  claimNextDocJob,
  completeDocJob,
  failDocJob,
  holdDocJob,
  requeueStaleDocJobs,
  touchDocJob,
  type DocJob,
} from "./queue.js";

// Un container Postgres per file di test: l'avvio costa secondi. I test si
// isolano svuotando doc_generation_jobs in afterEach (claimNextDocJob è
// globale: prende il job queued più vecchio dell'intera tabella).
let testDb: TestDb;
let repositoryId: string;

beforeAll(async () => {
  testDb = await startTestDb();
  const { db } = testDb;
  ({ repositoryId } = await seedRepository(db));
}, 120_000);

afterEach(async () => {
  await testDb.db.delete(docGenerationJobs);
});

afterAll(async () => {
  await testDb.stop();
});

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

interface EnqueueOptions {
  createdAt?: Date;
  status?: DocJob["status"];
  startedAt?: Date;
  lastActivityAt?: Date;
}

async function enqueueDocJob(db: Db, opts: EnqueueOptions = {}): Promise<DocJob> {
  const [job] = await db
    .insert(docGenerationJobs)
    .values({ repositoryId, ...opts })
    .returning();
  if (!job) throw new Error("insert del doc-job non ha restituito la riga");
  return job;
}

async function getDocJob(db: Db, id: string): Promise<DocJob> {
  const [job] = await db.select().from(docGenerationJobs).where(eq(docGenerationJobs.id, id));
  if (!job) throw new Error(`doc-job ${id} non trovato`);
  return job;
}

describe("claimNextDocJob", () => {
  it("prende il job queued più vecchio e lo marca running con startedAt", async () => {
    const { db } = testDb;
    const oldest = await enqueueDocJob(db, { createdAt: minutesAgo(3) });
    await enqueueDocJob(db, { createdAt: minutesAgo(2) });
    await enqueueDocJob(db, { createdAt: minutesAgo(1) });

    const claimed = await claimNextDocJob(db);

    expect(claimed?.id).toBe(oldest.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).not.toBeNull();
    // Il claim è attività: il job parte con l'heartbeat fresco.
    expect(claimed?.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    const persisted = await getDocJob(db, oldest.id);
    expect(persisted.status).toBe("running");
    expect(persisted.startedAt).not.toBeNull();
  });

  it("restituisce null se non ci sono job queued", async () => {
    const { db } = testDb;
    expect(await claimNextDocJob(db)).toBeNull();

    // Un job già in lavorazione non è reclamabile.
    await enqueueDocJob(db, { status: "running", startedAt: new Date() });
    expect(await claimNextDocJob(db)).toBeNull();
  });

  it("claim concorrenti non prendono mai lo stesso job", async () => {
    const { db } = testDb;
    await enqueueDocJob(db, { createdAt: minutesAgo(3) });
    await enqueueDocJob(db, { createdAt: minutesAgo(2) });
    await enqueueDocJob(db, { createdAt: minutesAgo(1) });

    const results = await Promise.all([
      claimNextDocJob(db),
      claimNextDocJob(db),
      claimNextDocJob(db),
      claimNextDocJob(db),
      claimNextDocJob(db),
    ]);

    const claimed = results.filter((job): job is DocJob => job !== null);
    const nulls = results.filter((job) => job === null);
    expect(claimed).toHaveLength(3);
    expect(nulls).toHaveLength(2);
    expect(new Set(claimed.map((job) => job.id)).size).toBe(3);
  });
});

describe("transizioni di stato", () => {
  it("completeDocJob marca succeeded con generationId, log e finishedAt", async () => {
    const { db } = testDb;
    const [generation] = await db.insert(docGenerations).values({ repositoryId }).returning();
    if (!generation) throw new Error("insert della generazione non ha restituito la riga");
    const job = await enqueueDocJob(db);
    await claimNextDocJob(db);

    const updated = await completeDocJob(db, job.id, {
      log: "generazione completata",
      generationId: generation.id,
    });

    expect(updated).toBe(true);
    const persisted = await getDocJob(db, job.id);
    expect(persisted.status).toBe("succeeded");
    expect(persisted.log).toContain("generazione completata");
    expect(persisted.finishedAt).not.toBeNull();
    // Il branch condizionale collega la generazione prodotta al job.
    expect(persisted.generationId).toBe(generation.id);
  });

  it("failDocJob marca failed con errore, log e finishedAt", async () => {
    const { db } = testDb;
    const job = await enqueueDocJob(db);
    await claimNextDocJob(db);

    const updated = await failDocJob(db, job.id, {
      log: "stacktrace del fallimento",
      error: "clone fallito",
    });

    expect(updated).toBe(true);
    const persisted = await getDocJob(db, job.id);
    expect(persisted.status).toBe("failed");
    expect(persisted.error).toBe("clone fallito");
    expect(persisted.log).toContain("stacktrace del fallimento");
    expect(persisted.finishedAt).not.toBeNull();
  });

  it("holdDocJob marca held registrando la ragione nell'errore e nel log, con finishedAt", async () => {
    const { db } = testDb;
    const job = await enqueueDocJob(db);
    await claimNextDocJob(db);

    const updated = await holdDocJob(db, job.id, { reason: "budget mensile superato" });

    expect(updated).toBe(true);
    const persisted = await getDocJob(db, job.id);
    expect(persisted.status).toBe("held");
    expect(persisted.error).toBe("budget mensile superato");
    expect(persisted.log).toContain("budget mensile superato");
    expect(persisted.finishedAt).not.toBeNull();
  });

  it("le transizioni su un job non in lavorazione restituiscono false e non toccano la riga", async () => {
    const { db } = testDb;
    const job = await enqueueDocJob(db); // ancora `queued`: nessuno lo possiede

    expect(await completeDocJob(db, job.id, { log: "tardivo" })).toBe(false);
    expect(await failDocJob(db, job.id, { log: "tardivo", error: "boom" })).toBe(false);
    expect(await holdDocJob(db, job.id, { reason: "tardivo" })).toBe(false);

    const persisted = await getDocJob(db, job.id);
    expect(persisted.status).toBe("queued");
    expect(persisted.log).toBe("");
    expect(persisted.error).toBeNull();
    expect(persisted.finishedAt).toBeNull();
  });

  it("un worker che ha perso la ownership riceve false e la riga resta del nuovo worker", async () => {
    const { db } = testDb;
    const job = await enqueueDocJob(db);

    // Il worker A reclama il job ma si blocca senza dare segni di vita...
    await claimNextDocJob(db);
    await db
      .update(docGenerationJobs)
      .set({ startedAt: minutesAgo(30), lastActivityAt: minutesAgo(30) })
      .where(eq(docGenerationJobs.id, job.id));

    // ...il job viene riportato in coda e reclamato dal worker B, che lo chiude.
    expect(await requeueStaleDocJobs(db, { olderThanMinutes: 10 })).toBe(1);
    const reclaimed = await claimNextDocJob(db);
    expect(reclaimed?.id).toBe(job.id);
    expect(await completeDocJob(db, job.id, { log: "fatto da B" })).toBe(true);

    // A si risveglia e prova a chiudere a sua volta: deve ricevere false
    // e la riga (esito di B) non deve essere toccata.
    expect(await failDocJob(db, job.id, { log: "esito tardivo di A", error: "boom" })).toBe(false);
    expect(await holdDocJob(db, job.id, { reason: "tardivo di A" })).toBe(false);

    const persisted = await getDocJob(db, job.id);
    expect(persisted.status).toBe("succeeded");
    expect(persisted.log).toContain("fatto da B");
    expect(persisted.log).not.toContain("esito tardivo di A");
  });

  it("appendDocJobLog accoda righe preservando quelle precedenti", async () => {
    const { db } = testDb;
    const job = await enqueueDocJob(db);

    await appendDocJobLog(db, job.id, "prima riga");
    await appendDocJobLog(db, job.id, "seconda riga");

    const persisted = await getDocJob(db, job.id);
    expect(persisted.log).toBe("prima riga\nseconda riga\n");
  });

  it("appendDocJobLog rinfresca lastActivityAt: è l'heartbeat gratuito del worker", async () => {
    const { db } = testDb;
    const job = await enqueueDocJob(db, {
      status: "running",
      startedAt: minutesAgo(30),
      lastActivityAt: minutesAgo(30),
    });

    await appendDocJobLog(db, job.id, "ancora al lavoro");

    const persisted = await getDocJob(db, job.id);
    expect(persisted.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("touchDocJob rinfresca lastActivityAt senza scrivere nel log (heartbeat silenzioso)", async () => {
    const { db } = testDb;
    const job = await enqueueDocJob(db, {
      status: "running",
      startedAt: minutesAgo(30),
      lastActivityAt: minutesAgo(30),
    });

    await touchDocJob(db, job.id);

    const persisted = await getDocJob(db, job.id);
    expect(persisted.lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Heartbeat silenzioso: niente rumore nel log a ogni battito.
    expect(persisted.log).toBe("");
  });
});

describe("requeueStaleDocJobs", () => {
  it("riporta in coda solo i job running senza attività da troppo tempo", async () => {
    const { db } = testDb;
    const stale = await enqueueDocJob(db, {
      status: "running",
      startedAt: minutesAgo(30),
      lastActivityAt: minutesAgo(30),
    });
    const fresh = await enqueueDocJob(db, {
      status: "running",
      startedAt: minutesAgo(2),
      lastActivityAt: minutesAgo(2),
    });
    const queued = await enqueueDocJob(db);
    const done = await enqueueDocJob(db, {
      status: "failed",
      startedAt: minutesAgo(60),
      lastActivityAt: minutesAgo(60),
    });

    const requeued = await requeueStaleDocJobs(db, { olderThanMinutes: 10 });

    expect(requeued).toBe(1);
    const staleAfter = await getDocJob(db, stale.id);
    expect(staleAfter.status).toBe("queued");
    expect(staleAfter.startedAt).toBeNull();
    expect(staleAfter.log).toContain("riportato in coda");
    expect((await getDocJob(db, fresh.id)).status).toBe("running");
    expect((await getDocJob(db, queued.id)).status).toBe("queued");
    expect((await getDocJob(db, done.id)).status).toBe("failed");
  });

  it("un heartbeat touchDocJob recente tiene il job fuori dal requeue anche oltre la soglia", async () => {
    const { db } = testDb;
    const longRunning = await enqueueDocJob(db, {
      status: "running",
      startedAt: minutesAgo(120),
      lastActivityAt: minutesAgo(120),
    });
    await touchDocJob(db, longRunning.id);

    const requeued = await requeueStaleDocJobs(db, { olderThanMinutes: 10 });

    expect(requeued).toBe(0);
    const persisted = await getDocJob(db, longRunning.id);
    expect(persisted.status).toBe("running");
    expect(persisted.startedAt).not.toBeNull();
    expect(persisted.log).not.toContain("riportato in coda");
  });
});
