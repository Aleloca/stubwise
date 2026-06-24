import { docAutoUpdateJobs } from "@stubwise/db";
import { lte, sql } from "drizzle-orm";
import type { ProjectSerializer } from "../handler.js";
import { runAutoUpdate, type AutoUpdateJob, type RunAutoUpdateDeps } from "./auto-update.js";

/**
 * POLLER DI DEBOUNCE dell'auto-aggiornamento Docs (Fase 1).
 *
 * Task SEPARATO dal loop dei job (come usage-poller / credential-tester): su un proprio
 * intervallo reclama i pending di `doc_auto_update_jobs` scaduti (`not_before <= now`) e
 * processa ciascuno via `runAutoUpdate` nella CATENA PER-PROGETTO (serializer condiviso
 * col fix e con la doc-generation), così l'auto-update non si sovrappone a un fetch
 * --prune dello stesso progetto (invariante del mirror).
 *
 * CLAIM ANTI-DOPPIONE: ogni pending viene RECLAMATO con un `DELETE ... RETURNING`
 * atomico PRIMA di processarlo. Reclamato = rimosso dalla tabella: un secondo tick (o un
 * secondo poller) non lo rivedrà mai. È l'approccio più semplice dato che la tabella ha
 * solo il pending (un per progetto, vincolo unique) senza colonna di stato.
 *
 * BEST-EFFORT (Fase 1): se il processing fallisce DOPO il claim, quel ciclo è perso (il
 * pending non esiste più). NON va in loop infinito: il prossimo push ricreerà un pending
 * col toSha aggiornato (e un fromSha che riparte dall'ultimo stato visto). Accettabile in
 * Fase 1: il changelog è additivo, non un'operazione che deve assolutamente completare.
 *
 * VINCOLI (come gli altri poller): NON fa MAI crashare il worker (ogni job in try/catch
 * isolato, l'intero tick a sua volta in try/catch) e NON tocca il lock/heartbeat né i
 * timeout dei job (nessun impatto sull'invariante WORKER_STALE_MINUTES). Si ferma
 * sull'AbortSignal del worker.
 */

export interface PollAutoUpdateDeps extends RunAutoUpdateDeps {
  /** Catena per-progetto CONDIVISA col fix e la doc-generation (serializzazione). */
  serializer: ProjectSerializer;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Esegue UN giro: reclama in modo atomico tutti i pending scaduti (`DELETE ... RETURNING`
 * dove `not_before <= now()`) e processa ciascuno nella catena del suo progetto. Non
 * lancia mai: errori per-job sono loggati e saltati. Ritorna il numero di job reclamati
 * (utile ai test).
 */
export async function pollAutoUpdateOnce(deps: PollAutoUpdateDeps): Promise<number> {
  // CLAIM: rimuove e restituisce in un colpo solo i pending scaduti. Atomico → niente
  // doppio processing tra tick o tra (futuri) processi.
  let claimed: AutoUpdateJob[];
  try {
    const rows = await deps.db
      .delete(docAutoUpdateJobs)
      .where(lte(docAutoUpdateJobs.notBefore, sql`now()`))
      .returning({
        id: docAutoUpdateJobs.id,
        projectId: docAutoUpdateJobs.projectId,
        fromSha: docAutoUpdateJobs.fromSha,
        toSha: docAutoUpdateJobs.toSha,
      });
    claimed = rows;
  } catch (err) {
    console.error(`[stubwise-worker] auto-update-poll: claim dei pending fallito: ${errText(err)}`);
    return 0;
  }

  for (const job of claimed) {
    try {
      // Catena per-progetto: l'auto-update si accoda dietro un eventuale fix/generazione
      // in corso dello stesso progetto (e li precede/segue serialmente).
      await deps.serializer.run(job.projectId, () => runAutoUpdate(deps, job));
    } catch (err) {
      // Best-effort: un job fallito non blocca gli altri reclamati in questo giro.
      console.error(
        `[stubwise-worker] auto-update-poll: job ${job.id} (progetto ${job.projectId}) saltato: ${errText(err)}`,
      );
    }
  }
  return claimed.length;
}

export interface StartAutoUpdatePollerOptions extends RunAutoUpdateDeps {
  serializer: ProjectSerializer;
  /** Intervallo di poll in secondi. ≤ 0 = disabilitato (non avvia nulla). */
  intervalSeconds: number;
  signal: AbortSignal;
}

/**
 * Avvia il poller su un proprio setInterval, separato dal loop dei job. Ad ogni tick
 * reclama ed esegue i pending scaduti. Lo stop avviene sull'AbortSignal del worker.
 * Ritorna una funzione di stop idempotente. intervalSeconds ≤ 0 = disabilitato.
 */
export function startAutoUpdatePoller(opts: StartAutoUpdatePollerOptions): () => void {
  if (opts.intervalSeconds <= 0) {
    return () => {};
  }
  const { intervalSeconds, signal, ...deps } = opts;
  let running = false;

  const tick = async (): Promise<void> => {
    // Evita sovrapposizioni se un giro è più lento dell'intervallo (un auto-update con
    // un agente lento può durare minuti).
    if (running) return;
    running = true;
    try {
      await pollAutoUpdateOnce(deps);
    } catch (err) {
      // Difesa finale: un tick non deve mai propagare.
      console.error(`[stubwise-worker] auto-update-poll: tick fallito: ${errText(err)}`);
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
