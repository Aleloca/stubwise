import { prReviewJobs, prReviews, repositories } from "@stubwise/db";
import { and, eq, lte, sql } from "drizzle-orm";
import type { ProjectSerializer } from "../handler.js";
import { runPrReview, type PrReviewJobRow, type RunPrReviewDeps } from "./run-review.js";

/**
 * POLLER DI DEBOUNCE dell'automazione PR Review (pattern auto-update-poller).
 *
 * Task SEPARATO dal loop dei job (come usage-poller / credential-tester): su un
 * proprio intervallo reclama i pending di `pr_review_jobs` scaduti
 * (`not_before <= now`) e processa ciascuno via `runPrReview` nella CATENA
 * PER-PROGETTO (serializer condiviso col fix e con la doc-generation), così la
 * review non si sovrappone a un fetch --prune dello stesso progetto (invariante
 * del mirror; un fix di progetto tiene worktree su tutti i suoi repo).
 *
 * CLAIM ANTI-DOPPIONE: ogni pending viene RECLAMATO con un `DELETE ... RETURNING`
 * atomico PRIMA di processarlo. Reclamato = rimosso dalla tabella: un secondo
 * tick (o un secondo poller) non lo rivedrà mai. È l'approccio più semplice dato
 * che la tabella ha solo il pending (uno per (repo, PR), vincolo unique) senza
 * colonna di stato.
 *
 * BEST-EFFORT: se il processing fallisce DOPO il claim, quel ciclo è perso (il
 * pending non esiste più). NON va in loop infinito: il prossimo push sulla PR
 * ricreerà un pending con la head aggiornata. Accettabile: una review è
 * un'analisi consultiva, non un'operazione che deve assolutamente completare.
 *
 * VINCOLI (come gli altri poller): NON fa MAI crashare il worker (ogni job in
 * try/catch isolato, l'intero tick a sua volta in try/catch) e NON tocca il
 * lock/heartbeat né i timeout dei job (nessun impatto sull'invariante
 * WORKER_STALE_MINUTES). Si ferma sull'AbortSignal del worker.
 */

export interface PollPrReviewsDeps extends RunPrReviewDeps {
  /** Catena per-progetto CONDIVISA col fix e la doc-generation (serializzazione). */
  serializer: ProjectSerializer;
  /** Minuti senza heartbeat oltre cui una riga pr_reviews `running` è orfana
   * di un worker morto e va chiusa failed (recovery in testa a ogni tick). */
  staleMinutes: number;
  /** Esecutore della singola review, iniettabile nei test. Default: runPrReview. */
  runPrReviewFn?: typeof runPrReview;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Esegue UN giro: (a) recovery delle righe `running` col heartbeat stantio,
 * (b) claim atomico di tutti i pending scaduti (`DELETE ... RETURNING` dove
 * `not_before <= now()`), (c) processing di ciascuno nella catena del suo
 * progetto. Non lancia mai: errori per-job sono loggati e saltati. Ritorna il
 * numero di job reclamati (utile ai test).
 */
export async function pollPrReviewsOnce(deps: PollPrReviewsDeps): Promise<number> {
  // Recovery: una review `running` col heartbeat fermo è un worker morto a
  // metà run (il claim è DELETE: il job non esiste più, nessun retry
  // automatico; il prossimo push sulla PR ri-accoda). La si chiude failed così
  // la UI non mostra run fantasma. Best-effort.
  try {
    await deps.db
      .update(prReviews)
      .set({
        status: "failed",
        error: "review interrotta: worker riavviato o run stantio",
        finishedAt: sql`now()`,
        lastActivityAt: sql`now()`,
      })
      .where(
        and(
          eq(prReviews.status, "running"),
          lte(prReviews.lastActivityAt, sql`now() - make_interval(mins => ${deps.staleMinutes})`),
        ),
      );
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review-poll: recovery delle review stantie fallito: ${errText(err)}`,
    );
  }

  // CLAIM: rimuove e restituisce in un colpo solo i pending scaduti. Atomico →
  // niente doppio processing tra tick o tra (futuri) processi.
  let claimed: PrReviewJobRow[];
  try {
    const rows = await deps.db
      .delete(prReviewJobs)
      .where(lte(prReviewJobs.notBefore, sql`now()`))
      .returning({
        repositoryId: prReviewJobs.repositoryId,
        prNumber: prReviewJobs.prNumber,
        prUrl: prReviewJobs.prUrl,
        prTitle: prReviewJobs.prTitle,
        prBody: prReviewJobs.prBody,
        sourceBranch: prReviewJobs.sourceBranch,
        targetBranch: prReviewJobs.targetBranch,
        headSha: prReviewJobs.headSha,
      });
    claimed = rows;
  } catch (err) {
    console.error(`[stubwise-worker] pr-review-poll: claim dei pending fallito: ${errText(err)}`);
    return 0;
  }

  const runPrReviewFn = deps.runPrReviewFn ?? runPrReview;
  for (const job of claimed) {
    try {
      // La catena di serializzazione è per PROGETTO: risolviamo il progetto del
      // repository per accodarci alla stessa catena del fix/generazione dello
      // STESSO progetto. Se il repository non esiste più, saltiamo il job
      // (best-effort).
      const [repo] = await deps.db
        .select({ projectId: repositories.projectId })
        .from(repositories)
        .where(eq(repositories.id, job.repositoryId));
      if (!repo) {
        console.error(
          `[stubwise-worker] pr-review-poll: repository ${job.repositoryId} non trovato, salto la review della PR #${job.prNumber}`,
        );
        continue;
      }
      // Catena per-progetto: la review si accoda dietro un eventuale
      // fix/generazione in corso dello stesso progetto (e li precede/segue
      // serialmente).
      await deps.serializer.run(repo.projectId, () => runPrReviewFn(deps, job));
    } catch (err) {
      // Best-effort: un job fallito non blocca gli altri reclamati in questo giro.
      console.error(
        `[stubwise-worker] pr-review-poll: review della PR #${job.prNumber} (repository ${job.repositoryId}) saltata: ${errText(err)}`,
      );
    }
  }
  return claimed.length;
}

export interface StartPrReviewPollerOptions extends PollPrReviewsDeps {
  /** Intervallo di poll in secondi. ≤ 0 = disabilitato (non avvia nulla). */
  intervalSeconds: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller su un proprio setInterval, separato dal loop dei job. Ad ogni
 * tick reclama ed esegue i pending scaduti. Lo stop avviene sull'AbortSignal
 * del worker. Ritorna una funzione di stop idempotente. intervalSeconds ≤ 0 =
 * disabilitato.
 */
export function startPrReviewPoller(opts: StartPrReviewPollerOptions): () => void {
  if (opts.intervalSeconds <= 0) {
    return () => {};
  }
  const { intervalSeconds, signal, ...deps } = opts;
  let running = false;

  const tick = async (): Promise<void> => {
    // Evita sovrapposizioni se un giro è più lento dell'intervallo (una review
    // con un agente lento può durare minuti).
    if (running) return;
    running = true;
    try {
      await pollPrReviewsOnce(deps);
    } catch (err) {
      // Difesa finale: un tick non deve mai propagare.
      console.error(`[stubwise-worker] pr-review-poll: tick fallito: ${errText(err)}`);
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
  signal.addEventListener("abort", stop, { once: true });
  return stop;
}
