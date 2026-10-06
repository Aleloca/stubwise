import { prReviewJobs, prReviews, repositories, type Db } from "@stubwise/db";
import { and, desc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { ProjectSerializer } from "../handler.js";
import {
  insertWaitingReview,
  runPrReview,
  type PrReviewJobRow,
  type RunPrReviewDeps,
} from "./run-review.js";

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
 * LA REVIEW ESISTE DAL CLAIM: nella STESSA transazione del DELETE nasce la riga
 * `pr_reviews` IN ATTESA (`running`, `started_at` null), che `runPrReview`
 * marca partita quando parte davvero. Fra claim e partenza (attesa nel
 * serializer, fino a ~139' dietro un fix) il ciclo della PR si legge quindi
 * `reviewing`, mai `idle`. Nessuna riga in attesa sopravvive al suo run
 * (`dropIfNeverStarted`); quelle rimaste nella catena in memoria di un processo
 * che non c'è più le rimette in coda `requeueWaitingReviews`, all'avvio.
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
  // Solo le PARTITE: una review in attesa non ha heartbeat e può restare nel
  // serializer dietro job di altri ticket ben oltre la soglia (~139' dietro UN
  // fix). Le righe in attesa le chiudono `dropIfNeverStarted` e, al riavvio,
  // `requeueWaitingReviews`.
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
          isNotNull(prReviews.startedAt),
          lte(prReviews.lastActivityAt, sql`now() - make_interval(mins => ${deps.staleMinutes})`),
        ),
      );
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review-poll: recovery delle review stantie fallito: ${errText(err)}`,
    );
  }

  // CLAIM + RIGHE IN ATTESA, in UNA transazione per TUTTO il batch: rimuove e
  // restituisce in un colpo solo i pending scaduti (atomico → niente doppio
  // processing tra tick o tra processi) e fa nascere le review nello stesso
  // istante (mai un momento in cui il ciclo della PR non vede né l'una né
  // l'altra). Un solo insert che fallisce annulla il claim INTERO: i job
  // restano in coda e il tick successivo ci riprova.
  let claimed: { job: PrReviewJobRow; reviewId: string }[];
  try {
    claimed = await deps.db.transaction(async (tx) => {
      const rows = await tx
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
          fromFork: prReviewJobs.fromFork,
        });
      const out: { job: PrReviewJobRow; reviewId: string }[] = [];
      for (const job of rows) out.push({ job, reviewId: await insertWaitingReview(tx, job) });
      return out;
    });
  } catch (err) {
    console.error(`[stubwise-worker] pr-review-poll: claim dei pending fallito: ${errText(err)}`);
    return 0;
  }

  const runPrReviewFn = deps.runPrReviewFn ?? runPrReview;
  for (const { job, reviewId } of claimed) {
    try {
      // La catena di serializzazione è per PROGETTO: risolviamo il progetto del
      // repository per accodarci alla stessa catena del fix/generazione dello
      // STESSO progetto. Se il repository non esiste più, saltiamo il job
      // (best-effort; la riga in attesa è già sparita in cascata).
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
      await deps.serializer.run(repo.projectId, () => runPrReviewFn(deps, job, reviewId));
    } catch (err) {
      // Best-effort: un job fallito non blocca gli altri reclamati in questo giro.
      console.error(
        `[stubwise-worker] pr-review-poll: review della PR #${job.prNumber} (repository ${job.repositoryId}) saltata: ${errText(err)}`,
      );
    } finally {
      await dropIfNeverStarted(deps.db, reviewId);
    }
  }
  return claimed.length;
}

/**
 * Nessuna riga in attesa sopravvive al suo run: se `runPrReview` è uscito
 * (o ha lanciato) senza marcarla partita, era una review che non doveva
 * esistere — toggle spento, PR chiusa, doppione —, come quando la riga
 * nasceva solo alla partenza. Una riga chiusa `failed` senza essere partita
 * (budget, provider) NON si tocca: la guardia è su `status = 'running'`.
 * Best-effort: la rete è requeueWaitingReviews. Esportata per i test
 * (`runClaimed` in run-review.test.ts fa ciò che fa il poller).
 */
export async function dropIfNeverStarted(db: Db, reviewId: string): Promise<void> {
  try {
    await db
      .delete(prReviews)
      .where(and(eq(prReviews.id, reviewId), eq(prReviews.status, "running"), isNull(prReviews.startedAt)));
  } catch (err) {
    console.error(
      `[stubwise-worker] pr-review-poll: pulizia della review in attesa ${reviewId} fallita: ${errText(err)}`,
    );
  }
}

/**
 * AVVIO DEL WORKER: le review rimaste IN ATTESA (`running`, `started_at`
 * null) stavano nella catena in memoria di un processo che non c'è più.
 * Tornano in `pr_review_jobs` (`not_before = now()`, head e metadati dalla
 * riga; su conflitto si sposta solo `not_before`: un push più nuovo già in
 * coda vince) e la riga sparisce, nella STESSA transazione — il ciclo della
 * PR resta `reviewing` per tutto il riavvio. Senza metadati (binario
 * intermedio) non si può riaccodare: `failed`. Dalla più recente: con due
 * righe in attesa sulla stessa PR entra in coda la head più nuova, l'altra
 * sposta solo `not_before`.
 *
 * ⚠️ Da chiamare PRIMA di qualunque poller, e vale solo con UN processo
 * worker per istanza — la stessa assunzione del serializer (handler.ts,
 * `ProjectSerializer`). Con due processi, l'avvio del secondo riaccoderebbe le
 * righe in attesa nella catena del primo e la review girerebbe due volte: se
 * il worker diventa multi-processo, questa funzione si rivede INSIEME al
 * serializer.
 */
/**
 * `requeueWaitingReviews` per l'AVVIO del worker: un errore (DB giù, query
 * fallita) si logga e dà 0 — il worker parte lo stesso, le righe restano in
 * attesa e ci riprova il prossimo avvio. `requeue` è iniettabile nei test.
 */
export async function requeueWaitingReviewsAtStartup(
  db: Db,
  requeue: typeof requeueWaitingReviews = requeueWaitingReviews,
): Promise<number> {
  try {
    const requeued = await requeue(db);
    if (requeued > 0) {
      console.error(`[stubwise-worker] ${requeued} review in attesa rimesse in coda dopo il riavvio`);
    }
    return requeued;
  } catch (err) {
    console.error(
      `[stubwise-worker] riaccodamento delle review in attesa fallito all'avvio: ${errText(err)}`,
    );
    return 0;
  }
}

export async function requeueWaitingReviews(db: Db): Promise<number> {
  const waiting = await db
    .select()
    .from(prReviews)
    .where(and(eq(prReviews.status, "running"), isNull(prReviews.startedAt)))
    .orderBy(desc(prReviews.createdAt));
  let requeued = 0;
  for (const row of waiting) {
    try {
      await db.transaction(async (tx) => {
        if (row.sourceBranch === null || row.targetBranch === null) {
          await tx
            .update(prReviews)
            .set({
              status: "failed",
              error: "review interrotta prima di partire: metadati del job assenti",
              finishedAt: sql`now()`,
              lastActivityAt: sql`now()`,
            })
            .where(and(eq(prReviews.id, row.id), eq(prReviews.status, "running"), isNull(prReviews.startedAt)));
          return;
        }
        await tx
          .insert(prReviewJobs)
          .values({
            repositoryId: row.repositoryId,
            prNumber: row.prNumber,
            prUrl: row.prUrl,
            prTitle: row.prTitle,
            prBody: row.prBody ?? "",
            sourceBranch: row.sourceBranch,
            targetBranch: row.targetBranch,
            headSha: row.headSha,
            fromFork: row.fromFork,
            notBefore: sql`now()`,
          })
          .onConflictDoUpdate({
            target: [prReviewJobs.repositoryId, prReviewJobs.prNumber],
            set: { notBefore: sql`now()` },
          });
        await tx.delete(prReviews).where(eq(prReviews.id, row.id));
        requeued += 1;
      });
    } catch (err) {
      console.error(
        `[stubwise-worker] pr-review: riaccodamento della review in attesa ${row.id} fallito: ${errText(err)}`,
      );
    }
  }
  return requeued;
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
