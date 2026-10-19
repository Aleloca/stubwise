import { backlogJobs, type Db } from "@stubwise/db";
import {
  backlogEstimatePayloadSchema,
  backlogIntakePayloadSchema,
  type BacklogEstimatePayload,
  type BacklogIntakePayload,
} from "@stubwise/shared";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { EmbeddingProvider } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import type { AgentRunner } from "../agent/runner.js";
import { getContentLanguage } from "../settings.js";
import type { ProjectSerializer } from "../handler.js";
import { QuotaWaitLog } from "../providers/quota-wait.js";
import type { SelectDeps } from "../providers/select.js";
import { runEstimate } from "./estimate.js";
import { runIntake } from "./intake.js";
import { NoAccountAvailableError } from "./provider.js";

/**
 * CODA `backlog_jobs` — il worker del backlog di discovery.
 *
 * Task SEPARATO dal loop dei fix (pattern pr-review / daily-report poller): su un
 * proprio intervallo reclama i job `queued` più vecchi uno a uno (claim atomico
 * `FOR UPDATE SKIP LOCKED`, come `ai_jobs`) e li processa nella CATENA
 * PER-PROGETTO (serializer condiviso col fix/doc-generation/review), così un
 * intake o una stima non si sovrappone al `fetch --prune` del mirror dello
 * stesso progetto. I kind sono solo `intake` ed `estimate`: chat della voce,
 * sessione di analisi e deep dive sono stati dismessi il 19 ott 2026 — sul
 * backlog si lavora con le sessioni di refinement (`refine/`).
 *
 * RETRY: ogni claim incrementa `attempts`. Un job che lancia torna `queued`
 * finché `attempts < MAX_BACKLOG_ATTEMPTS`, poi `failed`. ECCEZIONE: nessun
 * account AI disponibile (`NoAccountAvailableError`, provider.ts) non è un
 * fallimento — intake e stima tornano `queued` RESTITUENDO il tentativo. Un payload malformato
 * (non combacia con nessuna forma della union) è un errore PERMANENTE: `failed`
 * subito, senza retry (ritentarlo non cambierebbe l'esito).
 *
 * RECOVERY ORFANI (fase 0 del tick): un job `running` con `startedAt` oltre la
 * soglia di staleness è orfano di un worker crashato a metà lavoro — torna
 * `queued` (se ha ancora tentativi) o `failed` (esauriti).
 *
 * BEST-EFFORT come gli altri poller: NON fa MAI crashare il worker (ogni job in
 * try/catch isolato, l'intero tick a sua volta). Si ferma sull'AbortSignal.
 */

/** Tentativi massimi di un job del backlog prima del fallimento definitivo. */
export const MAX_BACKLOG_ATTEMPTS = 3;

/** Minuti oltre cui un job `running` è considerato orfano di un worker morto. */
export const BACKLOG_STALE_MINUTES = 15;

export type BacklogJob = typeof backlogJobs.$inferSelect;

/**
 * Logger minimale (sottoinsieme di pino / `console`): `warn` soddisfa anche il
 * `RetrievalLogger` di `retrieveChunksForProject`. Iniettato esplicitamente così
 * l'intake NON cade sul `console.warn` di default del retrieval.
 */
export interface BacklogLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Dipendenze condivise da poller e intake (deps esplicite e iniettabili, pattern
 * PollDailyReportsDeps). `workDir` è una directory temporanea vuota (creata dal
 * poller all'avvio) usata come cwd innocuo dei run dell'agente: nessun worktree,
 * il merge/intake ragionano solo sul testo passato nel prompt.
 */
export interface BacklogDeps {
  db: Db;
  embeddingClient: EmbeddingProvider;
  runner: AgentRunner;
  /** Catena per-progetto CONDIVISA col fix/doc-generation/review (serializzazione). */
  serializer: ProjectSerializer;
  logger: BacklogLogger;
  /** Soglia di similarità (0–1) sopra cui un nuovo feedback si FONDE in una voce. */
  mergeThreshold: number;
  /** Soglia di similarità (0–1) sopra cui una voce nuova segnala "simile a X". */
  similarThreshold: number;
  /** Modello AI dei run (omesso = default del CLI). */
  model?: string;
  /** Timeout (ms) di ogni run dell'agente. */
  agentTimeoutMs: number;
  /** Directory vuota e innocua usata come cwd dei run dell'intake (nessun
   * worktree: il merge/intake ragionano solo sul testo del prompt). */
  workDir: string;
  /** Scelta dell'account (providers/select.ts), la stessa di index.ts per
   * tutto il worker. Nei test `selectProvidersFn` sostituisce la scelta vera. */
  select: SelectDeps;
}

/**
 * Esecutore dell'intake. Default: {@link runIntake}; iniettabile via
 * `BacklogPollerDeps.runIntakeFn` per testare la sola coda con un fake.
 */
export type RunIntakeFn = (
  deps: BacklogDeps,
  job: BacklogJob,
  payload: BacklogIntakePayload,
) => Promise<void>;

/**
 * Esecutore dell'estimate. Default: {@link runEstimate}; iniettabile via
 * `BacklogPollerDeps.runEstimateFn` per testare la sola coda con un fake.
 */
export type RunEstimateFn = (
  deps: BacklogDeps,
  job: BacklogJob,
  payload: BacklogEstimatePayload,
) => Promise<void>;

export interface BacklogPollerDeps extends BacklogDeps {
  /** "adesso" iniettabile nei test. Default new Date(). */
  now?: () => Date;
  /** Minuti oltre cui un `running` è orfano. Default BACKLOG_STALE_MINUTES. */
  staleMinutes?: number;
  /** Esecutore dell'intake, iniettabile nei test. Default runIntake. */
  runIntakeFn?: RunIntakeFn;
  /** Esecutore dell'estimate, iniettabile nei test. Default runEstimate. */
  runEstimateFn?: RunEstimateFn;
  /** Stop cooperativo: interrompe il drain a metà tick. */
  signal?: AbortSignal;
}

/**
 * Errore PERMANENTE del payload: il payload non combacia con nessuna forma
 * attesa (o non corrisponde al `kind` del job). Ritentare non cambierebbe
 * l'esito, quindi il poller marca il job `failed` SUBITO, senza riaccodarlo.
 */
export class MalformedBacklogPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedBacklogPayloadError";
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reclama atomicamente il job `queued` più vecchio e lo marca `running`,
 * incrementando `attempts`. Il claim è un singolo UPDATE con subquery
 * `FOR UPDATE SKIP LOCKED`: due worker concorrenti non prendono mai lo stesso
 * job (chi trova la riga lockata passa oltre, o riceve null se la coda è vuota).
 *
 * `excludeIds` esclude dei job dal claim (id già gestiti NEL TICK corrente): un
 * job che lancia torna `queued` per essere ritentato al PROSSIMO tick, non
 * ri-reclamato subito nello stesso drain (altrimenti brucerebbe tutti i tentativi
 * in un colpo). Gli id sono param-bindati (niente injection). Insieme vuoto
 * (default) = nessuna esclusione.
 */
export async function claimNextBacklogJob(
  db: Db,
  excludeIds: string[] = [],
): Promise<BacklogJob | null> {
  // Il filtro sui kind è esplicito (non «tutti») così un kind aggiunto in futuro
  // all'enum non viene reclamato da un poller che non lo sa eseguire.
  // Tiebreaker `created_at, id`: due job con lo STESSO created_at (stesso
  // istante) hanno comunque un ordine stabile.
  const exclude =
    excludeIds.length === 0
      ? sql``
      : sql` AND id NOT IN (${sql.join(
          excludeIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  const subquery = sql`(SELECT id FROM backlog_jobs WHERE status = 'queued' AND kind IN ('intake', 'estimate')${exclude} ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)`;
  const [job] = await db
    .update(backlogJobs)
    .set({
      status: "running",
      startedAt: sql`now()`,
      attempts: sql`${backlogJobs.attempts} + 1`,
    })
    .where(eq(backlogJobs.id, subquery))
    .returning();
  return job ?? null;
}

/**
 * Recupero degli orfani (fase 0 del tick): i job `running` col `startedAt` oltre
 * la soglia sono di un worker crashato. Se hanno ancora tentativi tornano
 * `queued` (startedAt azzerato), altrimenti `failed`. Due UPDATE distinti (il
 * ramo dipende da `attempts`). Il poller è single-process e i tick non si
 * sovrappongono (guard `running` in startBacklogPoller), quindi un `running`
 * stantio è sempre orfano, mai vivo.
 */
export async function recoverStaleBacklogJobs(
  db: Db,
  staleMinutes: number,
  maxAttempts: number,
): Promise<void> {
  const stale = sql`${backlogJobs.startedAt} < now() - make_interval(mins => ${staleMinutes}::int)`;
  await db
    .update(backlogJobs)
    .set({ status: "queued", startedAt: null })
    .where(and(eq(backlogJobs.status, "running"), stale, lt(backlogJobs.attempts, maxAttempts)));
  await db
    .update(backlogJobs)
    .set({ status: "failed", error: "max attempts", finishedAt: sql`now()` })
    .where(and(eq(backlogJobs.status, "running"), stale, gte(backlogJobs.attempts, maxAttempts)));
}

/**
 * Transizioni terminali/di ritorno, tutte status-guarded su `running`: se il job
 * è stato riaccodato e reclamato altrove (o già chiuso) l'UPDATE non tocca righe
 * e non si sovrascrive nulla.
 */
async function completeBacklogJob(db: Db, jobId: string): Promise<void> {
  await db
    .update(backlogJobs)
    .set({ status: "done", error: null, finishedAt: sql`now()` })
    .where(and(eq(backlogJobs.id, jobId), eq(backlogJobs.status, "running")));
}

async function failBacklogJob(db: Db, jobId: string, error: string): Promise<void> {
  await db
    .update(backlogJobs)
    .set({ status: "failed", error, finishedAt: sql`now()` })
    .where(and(eq(backlogJobs.id, jobId), eq(backlogJobs.status, "running")));
}

/**
 * Nessun account disponibile (quota): il job torna `queued` RESTITUENDO il
 * tentativo (`attempts - 1`), guardato su `running`. Senza la restituzione tre
 * tick senza account porterebbero il job a `failed` (MAX_BACKLOG_ATTEMPTS)
 * per una ragione che non è sua. Nessun `not_before`: il tick successivo lo
 * riprende, rifà la scelta (una lettura, nessun run) e lo rimette qui.
 */
async function requeueBacklogJobForQuota(db: Db, jobId: string, error: string): Promise<void> {
  await db
    .update(backlogJobs)
    .set({
      status: "queued",
      startedAt: null,
      error,
      attempts: sql`greatest(${backlogJobs.attempts} - 1, 0)`,
    })
    .where(and(eq(backlogJobs.id, jobId), eq(backlogJobs.status, "running")));
}

/** Job del backlog in attesa di un account: si logga solo all'ingresso nell'attesa. */
const quotaWaits = new QuotaWaitLog();

async function requeueBacklogJob(db: Db, jobId: string, error: string): Promise<void> {
  await db
    .update(backlogJobs)
    .set({ status: "queued", startedAt: null, error })
    .where(and(eq(backlogJobs.id, jobId), eq(backlogJobs.status, "running")));
}

/**
 * Smista un job reclamato sul suo `kind`, validando prima il payload contro la
 * forma attesa. Un payload che non combacia → {@link MalformedBacklogPayloadError}
 * (fallimento permanente). `intake` esegue l'intake (dedup + generazione voce);
 * `estimate` stima i soli metadati + embedding di una voce già pronta (vedi
 * estimate.ts). Un `kind` sconosciuto è un errore PERMANENTE (difesa: il claim
 * filtra già i kind, ma un job che arrivasse qui comunque si chiude `failed`
 * invece di girare a vuoto fra un tentativo e l'altro).
 */
export async function runBacklogJob(deps: BacklogPollerDeps, job: BacklogJob): Promise<void> {
  if (job.kind === "intake") {
    const runIntakeFn = deps.runIntakeFn ?? runIntake;
    const parsed = backlogIntakePayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      throw new MalformedBacklogPayloadError(`payload intake non valido: ${parsed.error.message}`);
    }
    await runIntakeFn(deps, job, parsed.data);
    return;
  }
  if (job.kind === "estimate") {
    const runEstimateFn = deps.runEstimateFn ?? runEstimate;
    const parsed = backlogEstimatePayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      throw new MalformedBacklogPayloadError(
        `payload estimate non valido: ${parsed.error.message}`,
      );
    }
    await runEstimateFn(deps, job, parsed.data);
    return;
  }
  throw new MalformedBacklogPayloadError(`kind del job del backlog sconosciuto: ${String(job.kind)}`);
}

/**
 * Esegue UN giro: (0) recupero degli orfani `running` stantii, poi drena i job
 * `queued` reclamandoli uno a uno e processandoli nella catena del loro
 * progetto. Ogni job in try/catch isolato: su throw il job torna `queued` (se
 * ha tentativi) o `failed` (esauriti / payload malformato). Ritorna il numero di
 * job processati con successo (utile ai test). Non lancia mai.
 */
export async function pollBacklogJobsOnce(deps: BacklogPollerDeps): Promise<number> {
  const staleMinutes = deps.staleMinutes ?? BACKLOG_STALE_MINUTES;

  try {
    await recoverStaleBacklogJobs(deps.db, staleMinutes, MAX_BACKLOG_ATTEMPTS);
  } catch (err) {
    deps.logger.error({ err }, "[backlog] recupero degli orfani 'running' fallito");
  }

  let done = 0;
  // Id già gestiti in QUESTO tick: un job riaccodato dopo un throw non va
  // ri-reclamato nello stesso drain (i suoi tentativi si spalmano sui tick).
  const handled: string[] = [];
  while (!deps.signal?.aborted) {
    let job: BacklogJob | null;
    try {
      job = await claimNextBacklogJob(deps.db, handled);
    } catch (err) {
      // Errore DB transitorio: interrompe il drain di questo tick, si riprova al
      // prossimo. Non fa fallire nessun job (nessuno è stato reclamato qui).
      deps.logger.error({ err }, "[backlog] claim del prossimo job fallito");
      break;
    }
    if (!job) break;
    const claimed = job;
    handled.push(claimed.id);

    try {
      await deps.serializer.run(claimed.projectId, () => runBacklogJob(deps, claimed));
      await completeBacklogJob(deps.db, claimed.id);
      quotaWaits.leave(claimed.id);
      done++;
    } catch (err) {
      try {
        if (err instanceof NoAccountAvailableError) {
          // Nessun account disponibile: NON è un fallimento del job. Intake e
          // stima (`interactive`) tornano in coda restituendo il tentativo,
          // ripresi al tick dopo.
          const lang = await getContentLanguage(deps.db);
          const text = t(lang, "backlog.noAccountAvailable");
          await requeueBacklogJobForQuota(deps.db, claimed.id, text);
          if (quotaWaits.enter(claimed.id)) {
            deps.logger.warn(
              { jobId: claimed.id, kind: claimed.kind, reason: err.reason },
              "[backlog] nessun account AI disponibile: job rimesso in coda finché un account torna libero",
            );
          }
        } else if (err instanceof MalformedBacklogPayloadError) {
          // Errore permanente: niente retry.
          await failBacklogJob(deps.db, claimed.id, errText(err));
        } else if (claimed.attempts >= MAX_BACKLOG_ATTEMPTS) {
          // Tentativi esauriti (attempts è già incrementato dal claim).
          await failBacklogJob(deps.db, claimed.id, `max attempts: ${errText(err)}`);
        } else {
          await requeueBacklogJob(deps.db, claimed.id, errText(err));
        }
        if (!(err instanceof NoAccountAvailableError)) quotaWaits.leave(claimed.id);
      } catch (txErr) {
        // Anche la transizione è fallita (DB irraggiungibile?): il job resta
        // `running` e verrà recuperato dalla fase orfani di un tick successivo.
        deps.logger.error(
          { err: txErr, jobId: claimed.id },
          "[backlog] chiusura/riaccodamento del job fallita",
        );
      }
    }
  }
  return done;
}

export interface StartBacklogPollerOptions extends BacklogPollerDeps {
  /** Intervallo di poll in secondi. ≤ 0 = disabilitato (non avvia nulla). */
  intervalSeconds: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller su un proprio setInterval, separato dal loop dei job. Ad ogni
 * tick recupera gli orfani e drena la coda. Lo stop avviene sull'AbortSignal del
 * worker (passato anche a `pollBacklogJobsOnce` per interrompere il drain a metà
 * tick). Ritorna una funzione di stop idempotente. intervalSeconds ≤ 0 =
 * disabilitato.
 */
export function startBacklogPoller(opts: StartBacklogPollerOptions): () => void {
  if (opts.intervalSeconds <= 0) {
    return () => {};
  }
  const { intervalSeconds, ...deps } = opts;
  let running = false;

  const tick = async (): Promise<void> => {
    // Evita sovrapposizioni se un giro è più lento dell'intervallo (i run
    // dell'agente possono durare secondi/minuti).
    if (running) return;
    running = true;
    try {
      await pollBacklogJobsOnce(deps);
    } catch (err) {
      // Difesa finale (pollBacklogJobsOnce già non lancia): mai propagare.
      deps.logger.error({ err }, "[backlog] tick fallito");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalSeconds * 1000);
  // Non tenere vivo il processo solo per il poller.
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
