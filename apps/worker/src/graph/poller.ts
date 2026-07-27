import { repositories, type Db, type GraphJob } from "@stubwise/db";
import { eq } from "drizzle-orm";
import type { ProjectSerializer } from "../handler.js";
import { runGraphBuild, type GraphBuildDeps } from "./build.js";
import {
  claimNextGraphJob,
  completeGraphJob,
  failGraphJob,
  GRAPH_STALE_MINUTES,
  MAX_GRAPH_ATTEMPTS,
  recoverStaleGraphJobs,
} from "./queue.js";

/**
 * POLLER della coda `graph_jobs`: task SEPARATO dal loop dei job (stesso pattern
 * di backlog/poller.ts, review/poller.ts, docs/auto-update-poller.ts), su un
 * proprio intervallo. A ogni tick recupera gli orfani `running` e drena la coda
 * reclamando i job claimabili uno a uno.
 *
 * CATENA PER-PROGETTO: ogni job gira dentro il ProjectSerializer CONDIVISO con
 * fix / doc-generation / review / backlog. Due motivi, entrambi vincolanti:
 *  - la build apre un worktree sul mirror del repository, e un `fetch --prune`
 *    concorrente di un altro job dello stesso progetto cancellerebbe ref non
 *    ancora pushati (limite documentato in mirrors.ts);
 *  - il labeling delle comunità usa il claude CLI, quindi una build non deve
 *    sovrapporsi ai run agente dello stesso progetto.
 *
 * DIVISIONE COL RUNNER (vedi build.ts): `runGraphBuild` ritorna `true` = build
 * riuscita, e la chiusura `done` la fa QUI (uniforme per tutti i kind);
 * `false` = fallita e GIÀ chiusa `failed` dal runner (con `repo_graphs`
 * allineato), quindi il poller non tocca più il job. Solo un'eccezione
 * IMPREVISTA (il runner cattura tutto il resto) risale fin qui e viene chiusa
 * `failed` dal poller.
 *
 * TENTATIVI: a differenza del backlog, `attempts` NON si incrementa al claim ma
 * nel RECOVERY (vedi queue.ts) — un job portato a termine nel giro normale non
 * consuma tentativi, riservati ai riavvii del worker a metà build. Di
 * conseguenza qui non c'è riaccodamento applicativo: un errore è terminale
 * (`failed`, visibile in UI su `repo_graphs`), il retry è la ri-accodatura del
 * prossimo push (o un rebuild manuale).
 *
 * LIMITE DEL PROVIDER: nessun check preventivo, coerentemente con TUTTI gli
 * altri poller (backlog, review, daily-report) — la pausa da limite esiste solo
 * dentro la pipeline fix/docs (ProviderLimitError → job `held` / generazione
 * `paused`, ripresi dal limit-resume-poller) e non è riusabile a costo zero qui.
 * Per il grafo non serve: il labeling è l'UNICA parte che chiama il modello ed è
 * NON bloccante (build.ts ricade su `--no-label`), quindi un provider al limite
 * degrada in un grafo con i placeholder "Community N", non in una build persa.
 *
 * BEST-EFFORT come gli altri poller: non fa MAI crashare il worker (ogni job in
 * try/catch isolato, e il tick a sua volta). Si ferma sull'AbortSignal.
 */

/**
 * Esecutore della build. Default: {@link runGraphBuild}; iniettabile via
 * `GraphPollerDeps.runGraphBuildFn` per testare la sola coda con un fake.
 */
export type RunGraphBuildFn = (deps: GraphBuildDeps, job: GraphJob) => Promise<boolean>;

export interface GraphPollerDeps extends GraphBuildDeps {
  /** Catena per-progetto CONDIVISA col fix/doc-generation/review/backlog. */
  serializer: ProjectSerializer;
  /** Minuti oltre cui un `running` è orfano. Default GRAPH_STALE_MINUTES. */
  staleMinutes?: number;
  /** Esecutore della build, iniettabile nei test. Default runGraphBuild. */
  runGraphBuildFn?: RunGraphBuildFn;
  /** Stop cooperativo: interrompe il drain a metà tick. */
  signal?: AbortSignal;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Progetto proprietario del repository del job: è la chiave del serializer.
 * Repository inesistente (cancellato mentre il job era in coda — la FK lo
 * cascaderebbe, quindi è un caso difensivo) → throw, il job finisce `failed`.
 */
async function resolveProjectId(db: Db, repositoryId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: repositories.projectId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  if (!row) throw new Error(`repository ${repositoryId} inesistente`);
  return row.projectId;
}

/**
 * Smista un job reclamato sul suo `kind`. Ritorna true se il job si è concluso
 * con successo (ed è stato chiuso `done` qui).
 */
async function dispatchGraphJob(deps: GraphPollerDeps, job: GraphJob): Promise<boolean> {
  if (job.kind === "build") {
    const runGraphBuildFn = deps.runGraphBuildFn ?? runGraphBuild;
    const ok = await runGraphBuildFn(deps, job);
    // false = il runner ha già chiuso il job `failed` e allineato `repo_graphs`:
    // toccarlo di nuovo sovrascriverebbe l'errore mostrato in UI.
    if (!ok) return false;
    await completeGraphJob(deps.db, job.id);
    return true;
  }
  if (job.kind === "setup_pr") {
    // TODO(Task 7): apertura della PR di configurazione graphify sul repository.
    // Finché non esiste il runner, il job viene chiuso `failed` con un errore
    // esplicito invece di restare in coda per sempre.
    await failGraphJob(deps.db, job.id, "setup_pr non ancora implementato");
    return false;
  }
  // Difensivo: `kind` è vincolato a compile-time (colonna text con enum TS), ma
  // una riga scritta da una versione futura non deve bloccare la coda.
  await failGraphJob(deps.db, job.id, `kind sconosciuto: ${String(job.kind)}`);
  return false;
}

/**
 * Esegue UN giro: (0) recupero degli orfani `running` stantii, poi drena la coda
 * reclamando i job claimabili uno a uno e processandoli nella catena del loro
 * progetto. Ogni job in try/catch isolato. Ritorna il numero di job conclusi con
 * successo (utile ai test). Non lancia mai.
 */
export async function pollGraphJobsOnce(deps: GraphPollerDeps): Promise<number> {
  const staleMinutes = deps.staleMinutes ?? GRAPH_STALE_MINUTES;

  try {
    await recoverStaleGraphJobs(deps.db, staleMinutes, MAX_GRAPH_ATTEMPTS);
  } catch (err) {
    deps.logger.error({ err }, "[graph] recupero degli orfani 'running' fallito");
  }

  let done = 0;
  // Id già visti in QUESTO tick: ogni esito del dispatch è terminale
  // (done/failed), quindi un job non può tornare claimabile nello stesso drain —
  // se succedesse (transizione a vuoto perché il job non è più `running`) questa
  // guardia evita di girare all'infinito sullo stesso id.
  const handled = new Set<string>();
  while (!deps.signal?.aborted) {
    let job: GraphJob | null;
    try {
      job = await claimNextGraphJob(deps.db);
    } catch (err) {
      // Errore DB transitorio: interrompe il drain di questo tick, si riprova al
      // prossimo. Nessun job è stato reclamato qui, quindi nulla da chiudere.
      deps.logger.error({ err }, "[graph] claim del prossimo job fallito");
      break;
    }
    if (!job) break;
    const claimed = job;
    if (handled.has(claimed.id)) {
      deps.logger.warn(
        { jobId: claimed.id },
        "[graph] job reclamato due volte nello stesso tick: interrompo il drain",
      );
      break;
    }
    handled.add(claimed.id);

    try {
      const projectId = await resolveProjectId(deps.db, claimed.repositoryId);
      const ok = await deps.serializer.run(projectId, () => dispatchGraphJob(deps, claimed));
      if (ok) done++;
    } catch (err) {
      // Eccezione IMPREVISTA (il runner cattura i propri errori): il job non
      // deve restare `running` fino al recovery.
      deps.logger.error(
        { err, jobId: claimed.id, repositoryId: claimed.repositoryId },
        "[graph] job del grafo fallito con un errore imprevisto",
      );
      try {
        await failGraphJob(deps.db, claimed.id, errText(err));
      } catch (txErr) {
        // Anche la chiusura è fallita (DB irraggiungibile?): il job resta
        // `running` e lo recupererà la fase orfani di un tick successivo.
        deps.logger.error(
          { err: txErr, jobId: claimed.id },
          "[graph] chiusura del job fallita",
        );
      }
    }
  }
  return done;
}

export interface StartGraphPollerOptions extends GraphPollerDeps {
  /** Intervallo di poll in secondi. ≤ 0 = disabilitato (non avvia nulla). */
  intervalSeconds: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller su un proprio setInterval, separato dal loop dei job. Lo stop
 * avviene sull'AbortSignal del worker (passato anche a `pollGraphJobsOnce` per
 * interrompere il drain a metà tick). Ritorna una funzione di stop idempotente.
 * intervalSeconds ≤ 0 = disabilitato.
 */
export function startGraphPoller(opts: StartGraphPollerOptions): () => void {
  if (opts.intervalSeconds <= 0) {
    return () => {};
  }
  const { intervalSeconds, ...deps } = opts;
  let running = false;

  const tick = async (): Promise<void> => {
    // Evita sovrapposizioni se un giro è più lento dell'intervallo: una build
    // dura minuti (extract + clustering + labeling).
    if (running) return;
    running = true;
    try {
      await pollGraphJobsOnce(deps);
    } catch (err) {
      // Difesa finale (pollGraphJobsOnce già non lancia): mai propagare.
      deps.logger.error({ err }, "[graph] tick fallito");
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
