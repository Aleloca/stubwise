import { backlogJobs, type Db } from "@stubwise/db";
import {
  backlogDeepDivePayloadSchema,
  backlogEstimatePayloadSchema,
  backlogIntakePayloadSchema,
  type BacklogDeepDivePayload,
  type BacklogEstimatePayload,
  type BacklogIntakePayload,
} from "@stubwise/shared";
import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import type { EmbeddingProvider } from "@stubwise/db";
import type { AgentRunner } from "../agent/runner.js";
import type { MirrorManager } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import { loadProviderById, loadProviderChain } from "../providers/chain.js";
import { runDeepDive } from "./deep-dive.js";
import { runEstimate } from "./estimate.js";
import { runIntake } from "./intake.js";

/**
 * CODA `backlog_jobs` — il worker del backlog di discovery.
 *
 * Task SEPARATO dal loop dei fix (pattern pr-review / daily-report poller): su un
 * proprio intervallo reclama i job `queued` più vecchi uno a uno (claim atomico
 * `FOR UPDATE SKIP LOCKED`, come `ai_jobs`) e li processa nella CATENA
 * PER-PROGETTO (serializer condiviso col fix/doc-generation/review), così un
 * intake/deep_dive non si sovrappone al `fetch --prune` del mirror dello stesso
 * progetto.
 *
 * RETRY: ogni claim incrementa `attempts`. Un job che lancia torna `queued`
 * finché `attempts < MAX_BACKLOG_ATTEMPTS`, poi `failed`. Un payload malformato
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
  /** Radice del volume dei knowledge graph (GRAPHS_DIR): quando presente, deep
   * dive e sessioni di analisi ricevono il blocco GRAFO DEL CODICE nel prompt e
   * l'allowlist read-only di graphify (vedi graph/agent-hint.ts). */
  graphsDir?: string;
  db: Db;
  embeddingClient: EmbeddingProvider;
  runner: AgentRunner;
  /** Mirror manager CONDIVISO col fix/doc-generation/review: il deep dive monta
   * un worktree read-only del repo (l'intake non lo usa). */
  mirrors: Pick<MirrorManager, "resolveDefaultBranchHead" | "withWorktreeAtSha">;
  /** Catena per-progetto CONDIVISA col fix/doc-generation/review (serializzazione). */
  serializer: ProjectSerializer;
  logger: BacklogLogger;
  /** Chiave AES-256 per decifrare credenziali git e segreti dei provider AI. */
  encryptionKey: Buffer;
  /** Soglia di similarità (0–1) sopra cui un nuovo feedback si FONDE in una voce. */
  mergeThreshold: number;
  /** Soglia di similarità (0–1) sopra cui una voce nuova segnala "simile a X". */
  similarThreshold: number;
  /** Modello AI dei run (omesso = default del CLI). */
  model?: string;
  /** Timeout (ms) di ogni run dell'agente. */
  agentTimeoutMs: number;
  /** Turni massimi del run di deep dive (esplorazione del codice). */
  deepDiveMaxTurns: number;
  /** Directory vuota e innocua usata come cwd dei run dell'intake (nessun
   * worktree: il merge/intake ragionano solo sul testo del prompt). */
  workDir: string;
  /** Risolutore di UN provider AI per id (iniettabile nei test). Default: loadProviderById. */
  loadProviderByIdFn?: typeof loadProviderById;
  /** Caricatore della catena di provider AI (iniettabile nei test). Default: loadProviderChain. */
  loadProviderChainFn?: typeof loadProviderChain;
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
 * Esecutore del deep dive. Default: {@link runDeepDive}; iniettabile via
 * `BacklogPollerDeps.runDeepDiveFn` per testare la sola coda con un fake.
 */
export type RunDeepDiveFn = (
  deps: BacklogDeps,
  job: BacklogJob,
  payload: BacklogDeepDivePayload,
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
  /** Esecutore del deep dive, iniettabile nei test. Default runDeepDive. */
  runDeepDiveFn?: RunDeepDiveFn;
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
  // Il poller lento (20s) claima SOLO intake/deep_dive: i turni di chat (kind
  // `chat_turn`) hanno un poller VELOCE dedicato (chat-turn-poller.ts) così una
  // domanda non aspetta l'intervallo lungo. Tiebreaker `created_at, id`: due job
  // con lo STESSO created_at (stesso istante) hanno comunque un ordine stabile.
  const exclude =
    excludeIds.length === 0
      ? sql``
      : sql` AND id NOT IN (${sql.join(
          excludeIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  const subquery = sql`(SELECT id FROM backlog_jobs WHERE status = 'queued' AND kind IN ('intake', 'deep_dive', 'estimate')${exclude} ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)`;
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
 * Reclama atomicamente il prossimo turno di chat (`kind = 'chat_turn'`) più
 * vecchio, con lo STESSO claim atomico di claimNextBacklogJob (`FOR UPDATE SKIP
 * LOCKED`, incremento attempts, tiebreaker `created_at, id`). Query sull'indice
 * parziale dei `queued`: costo trascurabile a ogni tick del poller veloce.
 * `excludeIds` esclude gli id già gestiti nel tick corrente (come il claim
 * lento). L'ORDINE dei turni conta (una sessione CLI è sequenziale): il
 * tiebreaker garantisce che due turni con lo stesso created_at abbiano comunque
 * un ordine deterministico.
 */
export async function claimNextChatTurnJob(
  db: Db,
  excludeIds: string[] = [],
): Promise<BacklogJob | null> {
  const exclude =
    excludeIds.length === 0
      ? sql``
      : sql` AND id NOT IN (${sql.join(
          excludeIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  const subquery = sql`(SELECT id FROM backlog_jobs WHERE status = 'queued' AND kind = 'chat_turn'${exclude} ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)`;
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
 *
 * KIND `chat_turn` ESCLUSO (simmetrico al filtro di claimNextBacklogJob): il
 * ciclo di vita dei turni di chat è interamente del FAST poller
 * (recoverStaleChatTurnJobs, chat-turn-poller.ts), che li FALLISCE senza retry
 * (un turno non si ritenta). Senza questo filtro un chat_turn orfano con
 * attempts<3 verrebbe rimesso `queued` qui e ri-eseguito dal fast poller,
 * violando l'invariante "un turno NON si retry-a" e creando una race coi due
 * recovery (lento 20s / veloce 2s).
 */
export async function recoverStaleBacklogJobs(
  db: Db,
  staleMinutes: number,
  maxAttempts: number,
): Promise<void> {
  const stale = sql`${backlogJobs.startedAt} < now() - make_interval(mins => ${staleMinutes}::int)`;
  const notChatTurn = ne(backlogJobs.kind, "chat_turn");
  await db
    .update(backlogJobs)
    .set({ status: "queued", startedAt: null })
    .where(and(eq(backlogJobs.status, "running"), notChatTurn, stale, lt(backlogJobs.attempts, maxAttempts)));
  await db
    .update(backlogJobs)
    .set({ status: "failed", error: "max attempts", finishedAt: sql`now()` })
    .where(and(eq(backlogJobs.status, "running"), notChatTurn, stale, gte(backlogJobs.attempts, maxAttempts)));
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
 * estimate.ts); `deep_dive` esegue l'approfondimento tecnico sul worktree del
 * repo scelto (vedi deep-dive.ts).
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
  // deep_dive
  const runDeepDiveFn = deps.runDeepDiveFn ?? runDeepDive;
  const parsed = backlogDeepDivePayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    throw new MalformedBacklogPayloadError(`payload deep_dive non valido: ${parsed.error.message}`);
  }
  await runDeepDiveFn(deps, job, parsed.data);
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
      done++;
    } catch (err) {
      try {
        if (err instanceof MalformedBacklogPayloadError) {
          // Errore permanente: niente retry.
          await failBacklogJob(deps.db, claimed.id, errText(err));
        } else if (claimed.attempts >= MAX_BACKLOG_ATTEMPTS) {
          // Tentativi esauriti (attempts è già incrementato dal claim).
          await failBacklogJob(deps.db, claimed.id, `max attempts: ${errText(err)}`);
        } else {
          await requeueBacklogJob(deps.db, claimed.id, errText(err));
        }
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
