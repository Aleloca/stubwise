import { docGenerationJobs, type Db } from "@stubwise/db";
import type { HeldReason } from "@stubwise/shared";
import { and, eq, sql } from "drizzle-orm";

export type DocJob = typeof docGenerationJobs.$inferSelect;

/**
 * Stato "in lavorazione" del job di generazione documentazione: un worker può
 * far avanzare o chiudere un doc-job solo finché è `running`. Le transizioni
 * terminali (completeDocJob/failDocJob/holdDocJob) filtrano su questo stato: se
 * nel frattempo il job è stato riportato in coda (requeueStaleDocJobs) e
 * reclamato da un altro worker, l'UPDATE non tocca righe e il chiamante riceve
 * false (ha perso la ownership, deve fermarsi). Mirror di ACTIVE_STATUSES in
 * apps/worker/src/queue.ts, ridotto a un solo stato perché il doc-job non ha
 * fasi intermedie come triage/fix.
 */
const ACTIVE_STATUS = "running" as const;

/**
 * Reclama atomicamente il doc-job `queued` più vecchio e lo marca `running`.
 * Il claim è un singolo UPDATE con subquery `FOR UPDATE SKIP LOCKED`: due
 * worker concorrenti non possono mai prendere lo stesso job, chi trova la
 * riga già lockata passa alla successiva (o riceve null se la coda è vuota).
 * L'ORDER BY created_at + il filtro su status sfruttano l'indice parziale
 * doc_generation_jobs_queued_created_at_idx. Mirror di claimNextJob.
 */
export async function claimNextDocJob(db: Db): Promise<DocJob | null> {
  const [job] = await db
    .update(docGenerationJobs)
    .set({ status: "running", startedAt: sql`now()`, lastActivityAt: sql`now()` })
    .where(
      eq(
        docGenerationJobs.id,
        sql`(SELECT id FROM doc_generation_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`,
      ),
    )
    .returning();
  return job ?? null;
}

/**
 * Accoda una riga al log del doc-job (con newline finale). L'append è fatto
 * lato DB (`log || riga`) così più scritture concorrenti non si perdono.
 * Aggiorna anche `lastActivityAt`: ogni riga di log è un heartbeat gratuito
 * che tiene il job fuori dal radar di requeueStaleDocJobs. Mirror di appendLog.
 */
export async function appendDocJobLog(db: Db, jobId: string, line: string): Promise<void> {
  await db
    .update(docGenerationJobs)
    .set({ log: sql`${docGenerationJobs.log} || ${`${line}\n`}`, lastActivityAt: sql`now()` })
    .where(eq(docGenerationJobs.id, jobId));
}

/**
 * Heartbeat silenzioso: bumpa SOLO `lastActivityAt`, senza toccare il log.
 * Pensato per essere chiamato a intervalli (<< della soglia di staleness) da
 * una generazione lunga ma viva (onProgress della pipeline), così
 * requeueStaleDocJobs non la riporta in coda creando una doppia generazione. A
 * differenza di appendDocJobLog non aggiunge rumore al log a ogni battito. Non
 * filtra sullo stato attivo: è idempotente e innocuo su un job già chiuso.
 * Mirror di touchJob.
 */
export async function touchDocJob(db: Db, jobId: string): Promise<void> {
  await db
    .update(docGenerationJobs)
    .set({ lastActivityAt: sql`now()` })
    .where(eq(docGenerationJobs.id, jobId));
}

export interface CompleteDocJobInput {
  /** Riga di log finale da accodare. */
  log: string;
  /** Generazione prodotta, da collegare al job (set null in schema). */
  generationId?: string;
}

/**
 * Chiude il doc-job come `succeeded`: accoda il log finale, collega
 * l'eventuale generazione prodotta e imposta `finishedAt`. Status-guarded su
 * `running`: restituisce false se il job non era più in lavorazione (ownership
 * persa), e il chiamante deve interpretarlo come "fermati, il job non è più
 * tuo". Mirror di completeJob.
 */
export async function completeDocJob(
  db: Db,
  jobId: string,
  input: CompleteDocJobInput,
): Promise<boolean> {
  const updated = await db
    .update(docGenerationJobs)
    .set({
      status: "succeeded",
      log: sql`${docGenerationJobs.log} || ${`${input.log}\n`}`,
      finishedAt: sql`now()`,
      lastActivityAt: sql`now()`,
      ...(input.generationId !== undefined ? { generationId: input.generationId } : {}),
    })
    .where(and(eq(docGenerationJobs.id, jobId), eq(docGenerationJobs.status, ACTIVE_STATUS)))
    .returning({ id: docGenerationJobs.id });
  return updated.length > 0;
}

export interface FailDocJobInput {
  log: string;
  error: string;
}

/**
 * Chiude il doc-job come `failed`: accoda il log, registra l'errore e
 * `finishedAt`. Come completeDocJob, restituisce false se la ownership è persa.
 * Mirror di failJob.
 */
export async function failDocJob(db: Db, jobId: string, input: FailDocJobInput): Promise<boolean> {
  const updated = await db
    .update(docGenerationJobs)
    .set({
      status: "failed",
      log: sql`${docGenerationJobs.log} || ${`${input.log}\n`}`,
      error: input.error,
      finishedAt: sql`now()`,
      lastActivityAt: sql`now()`,
    })
    .where(and(eq(docGenerationJobs.id, jobId), eq(docGenerationJobs.status, ACTIVE_STATUS)))
    .returning({ id: docGenerationJobs.id });
  return updated.length > 0;
}

export interface HoldDocJobInput {
  /** Ragione del blocco (es. cap di costo superato): salvata in error e log. */
  reason: string;
  /**
   * Classificazione del hold, OBBLIGATORIA: "limit" = provider AI al limite di
   * rate/usage (il resume poller riaccoderà il trigger automaticamente al
   * reset); "budget" = tetto di spesa superato; "other" = altra causa umana.
   */
  heldReason: HeldReason;
}

/**
 * Transizione running → held: la generazione è stata sospesa per una ragione
 * non-errore (tipicamente il cap di costo/budget superato). Imposta
 * `finishedAt` perché il run è concluso e attende un eventuale sblocco/riavvio
 * umano; la ragione finisce sia in `error` (per la UI) sia nel log. Mirror di
 * holdJob (status-guarded su `running`): restituisce false se la ownership è
 * persa e in quel caso il chiamante non deve toccare nulla.
 */
export async function holdDocJob(db: Db, jobId: string, input: HoldDocJobInput): Promise<boolean> {
  const updated = await db
    .update(docGenerationJobs)
    .set({
      status: "held",
      heldReason: input.heldReason,
      error: input.reason,
      log: sql`${docGenerationJobs.log} || ${`[stubwise] generazione sospesa: ${input.reason}\n`}`,
      finishedAt: sql`now()`,
      lastActivityAt: sql`now()`,
    })
    .where(and(eq(docGenerationJobs.id, jobId), eq(docGenerationJobs.status, ACTIVE_STATUS)))
    .returning({ id: docGenerationJobs.id });
  return updated.length > 0;
}

export interface RequeueStaleDocJobsOptions {
  olderThanMinutes: number;
}

/**
 * Riporta in coda i doc-job `running` senza attività oltre la soglia: è il
 * segno di un worker crashato a metà generazione. La staleness si misura su
 * `lastActivityAt` (non su `startedAt`): una generazione lunga che continua a
 * battere (touchDocJob/appendDocJobLog) è viva e non va toccata. `startedAt`
 * torna NULL e il log riceve una riga che documenta il recupero. Restituisce
 * quanti job sono stati ripristinati. Mirror di requeueStale.
 */
export async function requeueStaleDocJobs(
  db: Db,
  options: RequeueStaleDocJobsOptions,
): Promise<number> {
  const requeued = await db
    .update(docGenerationJobs)
    .set({
      status: "queued",
      startedAt: null,
      lastActivityAt: sql`now()`,
      log: sql`${docGenerationJobs.log} || ${"[stubwise] job riportato in coda: il worker non ha dato segni di vita entro il timeout\n"}`,
    })
    .where(
      and(
        eq(docGenerationJobs.status, ACTIVE_STATUS),
        sql`${docGenerationJobs.lastActivityAt} < now() - make_interval(mins => ${options.olderThanMinutes}::int)`,
      ),
    )
    .returning({ id: docGenerationJobs.id });
  return requeued.length;
}
