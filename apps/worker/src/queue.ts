import { aiJobs, type Db } from "@stubwise/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export type AiJob = typeof aiJobs.$inferSelect;

/**
 * Reclama atomicamente il job `queued` più vecchio e lo marca `triaging`.
 * Il claim è un singolo UPDATE con subquery `FOR UPDATE SKIP LOCKED`: due
 * worker concorrenti non possono mai prendere lo stesso job, chi trova la
 * riga già lockata passa alla successiva (o riceve null se la coda è vuota).
 */
export async function claimNextJob(db: Db): Promise<AiJob | null> {
  const [job] = await db
    .update(aiJobs)
    .set({ status: "triaging", startedAt: sql`now()` })
    .where(
      eq(
        aiJobs.id,
        sql`(SELECT id FROM ai_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`,
      ),
    )
    .returning();
  return job ?? null;
}

/**
 * Accoda una riga al log del job (con newline finale). L'append è fatto
 * lato DB (`log || riga`) così più scritture concorrenti non si perdono.
 */
export async function appendLog(db: Db, jobId: string, line: string): Promise<void> {
  await db
    .update(aiJobs)
    .set({ log: sql`${aiJobs.log} || ${`${line}\n`}` })
    .where(eq(aiJobs.id, jobId));
}

export interface CompleteJobInput {
  status: "pr_opened" | "skipped";
  log: string;
  prUrl?: string;
}

/**
 * Chiude il job con un esito positivo (`pr_opened` o `skipped`): accoda il
 * log finale, registra l'eventuale URL della PR e imposta `finishedAt`.
 */
export async function completeJob(db: Db, jobId: string, input: CompleteJobInput): Promise<void> {
  await db
    .update(aiJobs)
    .set({
      status: input.status,
      log: sql`${aiJobs.log} || ${`${input.log}\n`}`,
      finishedAt: sql`now()`,
      ...(input.prUrl !== undefined ? { prUrl: input.prUrl } : {}),
    })
    .where(eq(aiJobs.id, jobId));
}

export interface FailJobInput {
  log: string;
  error: string;
}

/** Chiude il job come `failed`: accoda il log, registra l'errore e `finishedAt`. */
export async function failJob(db: Db, jobId: string, input: FailJobInput): Promise<void> {
  await db
    .update(aiJobs)
    .set({
      status: "failed",
      log: sql`${aiJobs.log} || ${`${input.log}\n`}`,
      error: input.error,
      finishedAt: sql`now()`,
    })
    .where(eq(aiJobs.id, jobId));
}

/** Transizione triage → fix: il triage ha deciso che il bug è aggredibile. */
export async function markFixing(db: Db, jobId: string): Promise<void> {
  await db.update(aiJobs).set({ status: "fixing" }).where(eq(aiJobs.id, jobId));
}

export interface RequeueStaleOptions {
  olderThanMinutes: number;
}

/**
 * Riporta in coda i job rimasti `triaging`/`fixing` oltre la soglia: è il
 * segno di un worker crashato a metà lavoro. `startedAt` torna NULL e il
 * log riceve una riga che documenta il recupero. Restituisce quanti job
 * sono stati ripristinati.
 */
export async function requeueStale(db: Db, options: RequeueStaleOptions): Promise<number> {
  const requeued = await db
    .update(aiJobs)
    .set({
      status: "queued",
      startedAt: null,
      log: sql`${aiJobs.log} || ${"[stubwise] job riportato in coda: il worker non ha concluso entro il timeout\n"}`,
    })
    .where(
      and(
        inArray(aiJobs.status, ["triaging", "fixing"]),
        sql`${aiJobs.startedAt} < now() - make_interval(mins => ${options.olderThanMinutes}::int)`,
      ),
    )
    .returning({ id: aiJobs.id });
  return requeued.length;
}

export interface RunWorkerOptions {
  db: Db;
  /**
   * Esegue il lavoro vero (triage → fix, Task 22-24). Riceve il job già
   * reclamato (`triaging`); è sua responsabilità chiudere il job con
   * completeJob/failJob. Se lancia, il job viene marcato `failed`.
   */
  handler: (job: AiJob) => Promise<void>;
  /** Job in lavorazione contemporanea (default 2). */
  concurrency?: number;
  /** Intervallo di poll della coda quando non c'è niente da fare (default 3s). */
  pollMs?: number;
  /** Ferma il loop: smette di reclamare e attende i job in volo. */
  signal?: AbortSignal;
  /** Soglia oltre cui un job in lavorazione è considerato orfano (default 15'). */
  staleAfterMinutes?: number;
  /** Ogni quanto cercare job orfani (default 60s; il primo controllo è subito). */
  requeueEveryMs?: number;
}

/** Sleep interrompibile: si risolve subito se il segnale viene abortito. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });
}

/** Esegue l'handler su un job reclamato; se lancia, marca il job `failed`. */
async function runJob(db: Db, job: AiJob, handler: (job: AiJob) => Promise<void>): Promise<void> {
  try {
    await handler(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await failJob(db, job.id, { log: `[stubwise] handler fallito: ${message}`, error: message });
    } catch {
      // Anche il failJob è fallito (DB irraggiungibile?): il job resta in
      // lavorazione e verrà recuperato da requeueStale.
    }
  }
}

/**
 * Loop principale del worker: reclama job fino a saturare `concurrency`
 * (tracciandoli come promise in volo, niente thread), poi attende `pollMs`
 * e riprova. Periodicamente riporta in coda i job orfani di worker crashati
 * (il primo controllo avviene subito, all'avvio). Sull'abort smette di
 * reclamare e attende il completamento dei job in volo prima di risolvere.
 */
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const {
    db,
    handler,
    concurrency = 2,
    pollMs = 3000,
    signal,
    staleAfterMinutes = 15,
    requeueEveryMs = 60_000,
  } = options;

  const inFlight = new Set<Promise<void>>();
  let nextRequeueAt = 0; // 0 = il primo requeueStale parte subito.

  while (!signal?.aborted) {
    if (Date.now() >= nextRequeueAt) {
      nextRequeueAt = Date.now() + requeueEveryMs;
      await requeueStale(db, { olderThanMinutes: staleAfterMinutes });
    }

    while (inFlight.size < concurrency && !signal?.aborted) {
      const job = await claimNextJob(db);
      if (!job) break;
      const task = runJob(db, job, handler).finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);
    }

    await sleep(pollMs, signal);
  }

  await Promise.all(inFlight);
}
