import { agentRuns, aiJobs, type Db } from "@stubwise/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AgentRunUsage } from "./agent/runner.js";
import {
  claimNextDocJob as claimNextDocJobImpl,
  requeueStaleDocJobs as requeueStaleDocJobsImpl,
  type DocJob,
} from "./docs/queue.js";
import { requeueStaleNodes as requeueStaleNodesImpl } from "./docs/nodes.js";

export type AiJob = typeof aiJobs.$inferSelect;

export interface RecordAgentRunInput {
  jobId: string;
  phase: "triage" | "fix";
  /** Consumi del run, se presenti: niente usage → nessuna riga registrata. */
  usage?: AgentRunUsage;
}

/**
 * Registra i consumi di un run dell'agente: una riga `agent_runs` per ciascun
 * modello in `usage.models`. Il costo è quello per-modello quando il CLI lo
 * riporta, altrimenti null (non si tenta di spalmare il totale: meglio un dato
 * mancante che uno inventato). BEST-EFFORT: qualunque errore (DB, usage
 * malformato) viene inghiottito — la registrazione dei consumi non deve MAI
 * far fallire il job. Senza usage, o con usage senza modelli, non scrive nulla.
 *
 * numeric(12,6) in Postgres si mappa a stringa lato drizzle: il costo va
 * passato come stringa (toFixed) per evitare problemi di precisione.
 */
export async function recordAgentRun(db: Db, input: RecordAgentRunInput): Promise<void> {
  try {
    const models = input.usage?.models ?? [];
    if (models.length === 0) return;
    await db.insert(agentRuns).values(
      models.map((m) => ({
        jobId: input.jobId,
        phase: input.phase,
        model: m.model,
        inputTokens: Math.trunc(m.inputTokens) || 0,
        outputTokens: Math.trunc(m.outputTokens) || 0,
        cacheReadTokens: Math.trunc(m.cacheReadTokens) || 0,
        costUsd: m.costUsd !== undefined ? m.costUsd.toFixed(6) : null,
      })),
    );
  } catch {
    // Inghiottito di proposito: i consumi sono accessori, il job no.
  }
}

/**
 * Stati "in lavorazione": un worker può chiudere o far avanzare un job solo
 * finché è in uno di questi. Le transizioni terminali (completeJob/failJob)
 * e markFixing filtrano su questi stati: se nel frattempo il job è stato
 * riportato in coda e reclamato da un altro worker, l'UPDATE non tocca righe
 * e il chiamante riceve false (ha perso la ownership, deve fermarsi).
 */
const ACTIVE_STATUSES = ["triaging", "fixing"] as const;

/**
 * Reclama atomicamente il job `queued` più vecchio e lo marca `triaging`.
 * Il claim è un singolo UPDATE con subquery `FOR UPDATE SKIP LOCKED`: due
 * worker concorrenti non possono mai prendere lo stesso job, chi trova la
 * riga già lockata passa alla successiva (o riceve null se la coda è vuota).
 *
 * MUTUA ESCLUSIONE FIX↔GENERAZIONE (M7): `excludeRepositoryIds` esclude dal claim i
 * fix-job dei repository con una GENERAZIONE di documentazione attiva (worktree
 * aperto). Un fix farebbe `ensureMirror → fetch --prune` nel mirror condiviso del
 * repository, cancellando il ref `stubwise/*` checked-out del worktree di generazione
 * (limite documentato in mirrors.ts). La subquery joina ai_jobs→tickets per il
 * repository bersaglio (`tickets.repository_id`) e salta i job di quei repository; gli
 * ALTRI fix (repository senza generazione attiva, anche dello stesso progetto) restano
 * reclamabili nel loro ordine. Insieme vuoto (default) = nessuna esclusione,
 * comportamento storico. La generazione resta comunque la priorità BASSA (fix-first):
 * questa esclusione tocca solo i repository con un worktree aperto.
 */
export async function claimNextJob(
  db: Db,
  excludeRepositoryIds: string[] = [],
): Promise<AiJob | null> {
  // Subquery del claim: il job queued più vecchio, opzionalmente escludendo i repository
  // con una generazione attiva (join a tickets per il repository bersaglio). La lista di
  // esclusione è interpolata come tupla `(v1, v2, …)` per il NOT IN (drizzle param-binda
  // ciascun valore, niente SQL injection).
  const excludeTuple = sql.join(
    excludeRepositoryIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const subquery =
    excludeRepositoryIds.length === 0
      ? sql`(SELECT id FROM ai_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`
      : sql`(
          SELECT j.id FROM ai_jobs j
          JOIN tickets t ON t.id = j.ticket_id
          WHERE j.status = 'queued'
            AND t.repository_id NOT IN (${excludeTuple})
          ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
        )`;
  const [job] = await db
    .update(aiJobs)
    .set({ status: "triaging", startedAt: sql`now()`, lastActivityAt: sql`now()` })
    .where(eq(aiJobs.id, subquery))
    .returning();
  return job ?? null;
}

/**
 * Accoda una riga al log del job (con newline finale). L'append è fatto
 * lato DB (`log || riga`) così più scritture concorrenti non si perdono.
 * Aggiorna anche `lastActivityAt`: ogni riga di log è un heartbeat gratuito
 * che tiene il job fuori dal radar di requeueStale.
 */
export async function appendLog(db: Db, jobId: string, line: string): Promise<void> {
  await db
    .update(aiJobs)
    .set({ log: sql`${aiJobs.log} || ${`${line}\n`}`, lastActivityAt: sql`now()` })
    .where(eq(aiJobs.id, jobId));
}

/**
 * Heartbeat silenzioso: bumpa SOLO `lastActivityAt`, senza toccare il log.
 * Pensato per essere chiamato a intervalli (<< della soglia di staleness) da
 * un fix lungo ma vivo, così requeueStale non lo riporta in coda creando una
 * PR duplicata. A differenza di appendLog non aggiunge rumore al log a ogni
 * battito. Non filtra sugli stati attivi: è idempotente e innocuo su un job
 * già chiuso (bumpa una colonna che non cambia più nulla).
 */
export async function touchJob(db: Db, jobId: string): Promise<void> {
  await db.update(aiJobs).set({ lastActivityAt: sql`now()` }).where(eq(aiJobs.id, jobId));
}

/**
 * Registra su ai_jobs.provider_id la credenziale del provider effettivamente
 * usata per il job (la prima della catena, vedi handler.ts). Non status-guarded:
 * è solo un dato di storico/diagnosi e va scritto appena la credenziale è scelta,
 * prima che il job possa essere riaccodato. Best-effort: un errore (DB
 * transitorio, provider eliminato nel frattempo → FK) non deve far fallire il
 * job, l'auth è comunque già stata iniettata nel run.
 */
export async function setJobProvider(db: Db, jobId: string, providerId: string): Promise<void> {
  try {
    await db.update(aiJobs).set({ providerId }).where(eq(aiJobs.id, jobId));
  } catch {
    // Inghiottito: il provider_id è accessorio, il job no.
  }
}

export interface CompleteJobInput {
  status: "pr_opened" | "skipped";
  log: string;
  prUrl?: string;
}

/**
 * Invariante resume_mode/plan_text: questi campi sono di PROPRIETÀ di chi
 * rimette il job in coda (run-ai/approve-plan/reject-plan/requeueStale), NON
 * vengono azzerati alla chiusura terminale (completeJob/failJob/holdJob). Ogni
 * percorso che riporta un job a `queued` imposta esplicitamente resume_mode
 * (e gestisce plan_text), quindi le transizioni terminali qui sotto possono
 * lasciarli invariati senza rischio di stato sporco al prossimo claim.
 */

/**
 * Chiude il job con un esito positivo (`pr_opened` o `skipped`): accoda il
 * log finale, registra l'eventuale URL della PR e imposta `finishedAt`.
 * Restituisce false se il job non era più in lavorazione (ownership persa):
 * il chiamante deve interpretarlo come "fermati, il job non è più tuo".
 */
export async function completeJob(
  db: Db,
  jobId: string,
  input: CompleteJobInput,
): Promise<boolean> {
  const updated = await db
    .update(aiJobs)
    .set({
      status: input.status,
      log: sql`${aiJobs.log} || ${`${input.log}\n`}`,
      finishedAt: sql`now()`,
      lastActivityAt: sql`now()`,
      ...(input.prUrl !== undefined ? { prUrl: input.prUrl } : {}),
    })
    .where(and(eq(aiJobs.id, jobId), inArray(aiJobs.status, [...ACTIVE_STATUSES])))
    .returning({ id: aiJobs.id });
  return updated.length > 0;
}

export interface FailJobInput {
  log: string;
  error: string;
}

/**
 * Chiude il job come `failed`: accoda il log, registra l'errore e
 * `finishedAt`. Come completeJob, restituisce false se la ownership è persa.
 */
export async function failJob(db: Db, jobId: string, input: FailJobInput): Promise<boolean> {
  const updated = await db
    .update(aiJobs)
    .set({
      status: "failed",
      log: sql`${aiJobs.log} || ${`${input.log}\n`}`,
      error: input.error,
      finishedAt: sql`now()`,
      lastActivityAt: sql`now()`,
    })
    .where(and(eq(aiJobs.id, jobId), inArray(aiJobs.status, [...ACTIVE_STATUSES])))
    .returning({ id: aiJobs.id });
  return updated.length > 0;
}

/**
 * Transizione triage → fix: il triage ha deciso che il bug è aggredibile.
 * Restituisce false se la ownership è persa (job requeued e reclamato da
 * un altro worker): il chiamante non deve iniziare la fase di fix.
 */
export async function markFixing(db: Db, jobId: string): Promise<boolean> {
  const updated = await db
    .update(aiJobs)
    .set({ status: "fixing", lastActivityAt: sql`now()` })
    .where(and(eq(aiJobs.id, jobId), inArray(aiJobs.status, [...ACTIVE_STATUSES])))
    .returning({ id: aiJobs.id });
  return updated.length > 0;
}

export interface HoldJobInput {
  log: string;
}

/**
 * Transizione triage → held: il triage ha deciso "fix" ma il gate di
 * automazione non lo consente (auto-fix off per il tipo, oppure effort sopra
 * soglia) e il job non è stato avviato manualmente. Il job resta in attesa di
 * un avvio umano (POST /run-ai). Status-guarded come markFixing: restituisce
 * false se la ownership è persa (job requeued e reclamato altrove) e in quel
 * caso il chiamante non deve toccare nulla.
 */
export async function holdJob(db: Db, jobId: string, input: HoldJobInput): Promise<boolean> {
  const updated = await db
    .update(aiJobs)
    .set({
      status: "held",
      log: sql`${aiJobs.log} || ${`${input.log}\n`}`,
      finishedAt: sql`now()`,
      lastActivityAt: sql`now()`,
    })
    .where(and(eq(aiJobs.id, jobId), inArray(aiJobs.status, [...ACTIVE_STATUSES])))
    .returning({ id: aiJobs.id });
  return updated.length > 0;
}

export interface ParkForPlanApprovalInput {
  planText: string;
  log: string;
}

/**
 * Transizione fix → awaiting_plan_approval: la pianificazione ha prodotto un
 * piano pronto che attende l'approvazione umana. A differenza di holdJob NON
 * imposta finishedAt: il job non è concluso, è in pausa e riprenderà quando il
 * piano sarà approvato. Status-guarded come markFixing/holdJob: restituisce
 * false se la ownership è persa (job requeued e reclamato altrove) e in quel
 * caso il chiamante non deve toccare nulla.
 */
export async function parkForPlanApproval(
  db: Db,
  jobId: string,
  input: ParkForPlanApprovalInput,
): Promise<boolean> {
  const updated = await db
    .update(aiJobs)
    .set({
      status: "awaiting_plan_approval",
      planText: input.planText,
      log: sql`${aiJobs.log} || ${`${input.log}\n`}`,
      lastActivityAt: sql`now()`,
    })
    .where(and(eq(aiJobs.id, jobId), inArray(aiJobs.status, [...ACTIVE_STATUSES])))
    .returning({ id: aiJobs.id });
  return updated.length > 0;
}

export interface RequeueStaleOptions {
  olderThanMinutes: number;
}

/**
 * Riporta in coda i job `triaging`/`fixing` senza attività oltre la soglia:
 * è il segno di un worker crashato a metà lavoro. La staleness si misura su
 * `lastActivityAt` (non su `startedAt`): un fix lungo che continua a loggare
 * è vivo e non va toccato. `startedAt` torna NULL e il log riceve una riga
 * che documenta il recupero. Restituisce quanti job sono stati ripristinati.
 */
export async function requeueStale(db: Db, options: RequeueStaleOptions): Promise<number> {
  const requeued = await db
    .update(aiJobs)
    .set({
      status: "queued",
      startedAt: null,
      lastActivityAt: sql`now()`,
      log: sql`${aiJobs.log} || ${"[stubwise] job riportato in coda: il worker non ha dato segni di vita entro il timeout\n"}`,
    })
    .where(
      and(
        inArray(aiJobs.status, [...ACTIVE_STATUSES]),
        sql`${aiJobs.lastActivityAt} < now() - make_interval(mins => ${options.olderThanMinutes}::int)`,
      ),
    )
    .returning({ id: aiJobs.id });
  return requeued.length;
}

/**
 * Override test-only delle dipendenze interne di runWorker: permette di
 * simulare errori DB transitori e accelerare il backoff senza toccare
 * l'API pubblica. Non usare in produzione.
 */
export interface RunWorkerInternals {
  claimNextJob?: typeof claimNextJob;
  requeueStale?: typeof requeueStale;
  /** Override del claim dei doc-job (default claimNextDocJob). */
  claimNextDocJob?: typeof claimNextDocJobImpl;
  /** Override del requeue dei doc-job orfani (default requeueStaleDocJobs). */
  requeueStaleDocJobs?: typeof requeueStaleDocJobsImpl;
  /** Override del requeue dei nodi orfani del DAG (default requeueStaleNodes). */
  requeueStaleNodes?: typeof requeueStaleNodesImpl;
  /** Primo intervallo di backoff dopo un errore DB (default 1s). */
  backoffBaseMs?: number;
  /** Tetto del backoff esponenziale (default 30s). */
  backoffMaxMs?: number;
}

export interface RunWorkerOptions {
  db: Db;
  /**
   * Esegue il lavoro vero (triage → fix, Task 22-24). Riceve il job già
   * reclamato (`triaging`); è sua responsabilità chiudere il job con
   * completeJob/failJob. Se lancia, il job viene marcato `failed`.
   */
  handler: (job: AiJob) => Promise<void>;
  /**
   * Handler del TRIGGER di doc-generation (M7: avvia l'ORIENTAMENTO del DAG). Se
   * assente, il loop NON reclama doc-job (retro-compat: la sola pipeline fix).
   * Riceve il doc-job già reclamato (`running`); l'orientamento semina il DAG e
   * lascia il trigger `running` (lo chiude la finalizzazione), oppure lo fallisce.
   * Se lancia, il job è marcato `failed` via docHandlerOnError. DEVE condividere la
   * catena per-repository con `handler` (vedi createRepositorySerializer in handler.ts)
   * perché orientamento e fix dello stesso repository non si sovrappongano sul mirror.
   */
  docHandler?: (job: DocJob) => Promise<void>;
  /** Marca il doc-job `failed` se docHandler lancia (vedi failDocJobOnError). */
  docHandlerOnError?: (db: Db, job: DocJob, err: unknown) => Promise<void>;
  /**
   * Dispatch di UN job-nodo del DAG (M7): RECLAMA un nodo claimabile e, se c'è,
   * registra l'esecuzione (explore/synthesize + join + eventuale finalizzazione) via
   * `track(work)` e ritorna `true` APPENA fatto il claim — l'esecuzione prosegue in
   * background, tracciata in volo dal loop. Ritorna `false` (senza chiamare `track`)
   * se la coda nodi è vuota. Così il loop sa subito se continuare a reclamare nodi
   * (parallelizzano fino alla concorrenza) senza bloccarsi sull'esecuzione di un
   * agente. Se assente, il loop NON reclama job-nodo (retro-compat: niente DAG). I
   * job-nodo NON passano dal serializzatore per-progetto. Vedi node-dispatch.ts.
   */
  dispatchNode?: (track: (work: Promise<void>) => void) => Promise<boolean>;
  /**
   * Insieme dei repositoryId con una GENERAZIONE attiva (worktree aperto). Il loop NON
   * reclama fix-job di quei repository (mutua esclusione col mirror, M7): un fix farebbe
   * `fetch --prune` cancellando il ref checked-out del worktree di generazione. Di
   * default vuoto (nessuna esclusione). Vedi registry.activeRepositoryIds.
   */
  activeGenerationRepositoryIds?: () => Set<string>;
  /** Job in lavorazione contemporanea (default 2). */
  concurrency?: number;
  /** Intervallo di poll della coda quando non c'è niente da fare (default 3s). */
  pollMs?: number;
  /** Ferma il loop: smette di reclamare e attende i job in volo. */
  signal?: AbortSignal;
  /** Soglia di inattività oltre cui un job in lavorazione è orfano (default 30':
   * deve superare il timeout del fix + triage, vedi l'invariante in index.ts). */
  staleAfterMinutes?: number;
  /** Ogni quanto cercare job orfani (default 60s; il primo controllo è subito). */
  requeueEveryMs?: number;
  /** Solo per i test: vedi RunWorkerInternals. */
  _internals?: RunWorkerInternals;
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
      // Se restituisce false la ownership era già persa: il job è di un
      // altro worker, non c'è niente da marcare.
      await failJob(db, job.id, { log: `[stubwise] handler fallito: ${message}`, error: message });
    } catch {
      // Anche il failJob è fallito (DB irraggiungibile?): il job resta in
      // lavorazione e verrà recuperato da requeueStale.
    }
  }
}

/**
 * Esegue il docHandler su un doc-job reclamato; se lancia, marca il job
 * `failed` via onError (mirror di runJob per la coda fix).
 */
async function runDocJob(
  db: Db,
  job: DocJob,
  handler: (job: DocJob) => Promise<void>,
  onError: (db: Db, job: DocJob, err: unknown) => Promise<void>,
): Promise<void> {
  try {
    await handler(job);
  } catch (err) {
    await onError(db, job, err);
  }
}

/**
 * Loop principale del worker: reclama job fino a saturare `concurrency`
 * (tracciandoli come promise in volo, niente thread), poi attende `pollMs`
 * e riprova. Periodicamente riporta in coda i job orfani di worker crashati
 * (il primo controllo avviene subito, all'avvio). Gli errori DB transitori
 * non uccidono il loop: si riprova con backoff esponenziale (1s → 2s → 4s
 * → … → 30s, azzerato al primo successo). Sull'abort smette di reclamare e
 * attende il completamento dei job in volo prima di risolvere; i job in
 * volo vengono attesi anche se il loop terminasse per un errore imprevisto.
 */
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const {
    db,
    handler,
    docHandler,
    docHandlerOnError,
    dispatchNode,
    activeGenerationRepositoryIds,
    concurrency = 2,
    pollMs = 3000,
    signal,
    staleAfterMinutes = 15,
    requeueEveryMs = 60_000,
    _internals,
  } = options;
  const claim = _internals?.claimNextJob ?? claimNextJob;
  const requeue = _internals?.requeueStale ?? requeueStale;
  const claimDoc = _internals?.claimNextDocJob ?? claimNextDocJobImpl;
  const requeueDoc = _internals?.requeueStaleDocJobs ?? requeueStaleDocJobsImpl;
  const requeueNodes = _internals?.requeueStaleNodes ?? requeueStaleNodesImpl;
  const backoffBaseMs = _internals?.backoffBaseMs ?? 1000;
  const backoffMaxMs = _internals?.backoffMaxMs ?? 30_000;

  const inFlight = new Set<Promise<void>>();
  let nextRequeueAt = 0; // 0 = il primo requeueStale parte subito.
  let backoffMs = 0; // 0 = nessun errore DB recente.

  try {
    while (!signal?.aborted) {
      try {
        if (Date.now() >= nextRequeueAt) {
          await requeue(db, { olderThanMinutes: staleAfterMinutes });
          // requeue dei doc-job orfani sullo STESSO cadence dei fix: un doc-job
          // running senza heartbeat oltre soglia torna in coda (Task 5.4).
          if (docHandler) await requeueDoc(db, { olderThanMinutes: staleAfterMinutes });
          // requeue dei NODI orfani del DAG sullo STESSO cadence (M7): un nodo
          // exploring/synthesizing senza heartbeat oltre soglia torna claimabile
          // (la sua generazione verrà ri-aperta on-demand dal dispatch se necessario).
          if (dispatchNode) await requeueNodes(db, staleAfterMinutes);
          // Avanzato solo dopo il successo: se la requeue fallisce si
          // ritenta alla prossima iterazione, non tra requeueEveryMs.
          nextRequeueAt = Date.now() + requeueEveryMs;
        }

        // PRIORITÀ: i fix prima di tutto. Si satura `concurrency` con i fix
        // disponibili; SOLO se resta capacità (nessun fix in coda) si reclamano i
        // job-nodo del DAG, poi UN trigger di generazione per tick. Così le
        // generazioni di documentazione (lunghe e costose) non affamano i fix dei
        // bug, che restano la priorità del worker. Single-process: niente slot
        // dedicato, si condivide il budget di concorrenza. Politica loggata in index.ts.
        //
        // MUTUA ESCLUSIONE FIX↔GENERAZIONE (M7): i fix dei repository con una
        // generazione attiva (worktree aperto) sono ESCLUSI dal claim — un fix farebbe
        // `fetch --prune` cancellando il ref checked-out del worktree (vedi claimNextJob
        // e registry.activeRepositoryIds). Gli altri fix restano reclamabili.
        const excluded = activeGenerationRepositoryIds ? [...activeGenerationRepositoryIds()] : [];
        let claimedFix = false;
        while (inFlight.size < concurrency && !signal?.aborted) {
          const job = await claim(db, excluded);
          if (!job) break;
          claimedFix = true;
          const task = runJob(db, job, handler).finally(() => {
            inFlight.delete(task);
          });
          inFlight.add(task);
        }

        // JOB-NODO del DAG: solo a fix esauriti e con capacità libera. PARALLELIZZANO
        // fino a `concurrency` (il DAG si espande in larghezza). Si SONDA con un
        // dispatch ATTESO sul solo CLAIM (non sull'esecuzione): `dispatchNode` ritorna
        // appena saputo se un nodo è stato reclamato, mentre l'esecuzione (agente +
        // join + eventuale finalizzazione) prosegue in background, tracciata in volo
        // via `track`. Se il claim trova un nodo si continua a riempire la capacità;
        // se la coda nodi è vuota il dispatch ritorna false e ci si ferma (niente
        // busy-spin di no-op). Vedi node-dispatch.ts.
        if (dispatchNode) {
          while (!claimedFix && inFlight.size < concurrency && !signal?.aborted) {
            const claimedNode = await dispatchNode((work) => {
              const task = work.finally(() => {
                inFlight.delete(task);
              });
              inFlight.add(task);
            });
            if (!claimedNode) break;
          }
        }

        // Trigger di generazione (orientamento): solo a fix esauriti e con capacità
        // libera. Uno per tick: il prossimo arriva al giro successivo, dopo aver
        // ridato priorità ai fix e ai nodi del DAG in corso.
        if (
          docHandler &&
          docHandlerOnError &&
          !claimedFix &&
          inFlight.size < concurrency &&
          !signal?.aborted
        ) {
          const docJob = await claimDoc(db);
          if (docJob) {
            const task = runDocJob(db, docJob, docHandler, docHandlerOnError).finally(() => {
              inFlight.delete(task);
            });
            inFlight.add(task);
          }
        }

        backoffMs = 0;
      } catch {
        // Errore DB transitorio (connessione caduta, failover): non
        // uccidere il loop, riprova con backoff esponenziale.
        backoffMs = backoffMs === 0 ? backoffBaseMs : Math.min(backoffMs * 2, backoffMaxMs);
        await sleep(backoffMs, signal);
        continue;
      }

      await sleep(pollMs, signal);
    }
  } finally {
    // Qualunque cosa accada al loop, i job in volo vanno attesi: runWorker
    // non si risolve mai lasciando handler orfani in esecuzione.
    await Promise.all(inFlight);
  }
}
