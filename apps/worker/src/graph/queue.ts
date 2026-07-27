import { graphJobs, repoGraphs, type Db, type GraphJob } from "@stubwise/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";

/**
 * CODA `graph_jobs` — build del knowledge graph e PR di configurazione graphify.
 *
 * Stessa forma della coda del backlog (`backlog/poller.ts`): claim atomico con
 * `FOR UPDATE SKIP LOCKED`, recovery degli orfani sulla soglia di staleness,
 * tentativi massimi prima del fallimento definitivo. Qui ci sono SOLO le
 * transizioni di stato: il poller che le orchestra è a parte.
 *
 * TRE DIFFERENZE rispetto alla coda del backlog, tutte volute:
 *
 * 1. `not_before` — il webhook push fa debounce spostando in avanti il
 *    `not_before` del job `queued` esistente (indice unico parziale su
 *    `(repository_id, kind)` per gli stati vivi) invece di accodarne un secondo.
 *    Un job con `not_before` nel futuro NON è claimabile.
 * 2. `attempts` si incrementa nel RECOVERY, non al claim: un job reclamato e
 *    portato a termine nel giro normale non consuma tentativi, che restano
 *    riservati ai riavvii del worker a metà build.
 * 3. `updated_at` NON è mantenuto da alcun trigger: OGNI update qui sotto lo
 *    valorizza esplicitamente, altrimenti la colonna resterebbe all'insert.
 *
 * `repo_graphs` è lo stato del grafo OSSERVABILE dalla UI: un fallimento
 * definitivo (tentativi esauriti o errore del runner) vi si riflette con
 * `status='failed'` e lo stesso testo d'errore. L'aggiornamento è un upsert
 * perché la riga può non esistere ancora (build mai completata).
 */

/** Tentativi massimi di un job del grafo prima del fallimento definitivo. */
export const MAX_GRAPH_ATTEMPTS = 3;

/** Minuti oltre cui un job `running` è considerato orfano di un worker morto. */
export const GRAPH_STALE_MINUTES = 15;

/**
 * Tetto del testo d'errore persistito su `graph_jobs.error` / `repo_graphs.error`
 * (l'output di graphify può essere lungo migliaia di righe). Stesso ordine di
 * grandezza del troncamento dei log di triage/fix.
 */
export const GRAPH_ERROR_MAX_CHARS = 4000;

/** Tronca l'errore al tetto, segnalandolo esplicitamente. */
function truncateError(error: string): string {
  return error.length > GRAPH_ERROR_MAX_CHARS
    ? `${error.slice(0, GRAPH_ERROR_MAX_CHARS)}\n[errore troncato]`
    : error;
}

/**
 * Porta la riga di stato del grafo del repository a `failed` con l'errore dato.
 * UPSERT: la riga può non esistere (nessuna build mai arrivata in fondo). I dati
 * dell'ultima build riuscita (sha, contatori) restano leggibili accanto
 * all'errore: si sovrascrivono solo `status` ed `error`.
 */
async function markRepoGraphFailed(db: Db, repositoryId: string, error: string): Promise<void> {
  await db
    .insert(repoGraphs)
    .values({ repositoryId, status: "failed", error })
    .onConflictDoUpdate({
      target: repoGraphs.repositoryId,
      set: { status: "failed", error, updatedAt: sql`now()` },
    });
}

/**
 * Reclama atomicamente il job `queued` più vecchio ancora claimabile e lo marca
 * `running`. Il claim è un singolo UPDATE con subquery `FOR UPDATE SKIP LOCKED`:
 * due worker concorrenti non prendono mai lo stesso job (chi trova la riga
 * lockata passa oltre, o riceve null se la coda è vuota).
 *
 * Claimabile = `not_before` nullo o già scaduto: un job ancora in debounce viene
 * saltato e resta `queued` per un tick successivo (gli altri job restano
 * reclamabili nel loro ordine). Tiebreaker `created_at, id`: due job creati nello
 * stesso istante hanno comunque un ordine stabile.
 */
export async function claimNextGraphJob(db: Db): Promise<GraphJob | null> {
  const subquery = sql`(SELECT id FROM graph_jobs WHERE status = 'queued' AND (not_before IS NULL OR not_before <= now()) ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)`;
  const [job] = await db
    .update(graphJobs)
    .set({ status: "running", claimedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(graphJobs.id, subquery))
    .returning();
  return job ?? null;
}

/**
 * Recupero degli orfani: un job `running` col `claimed_at` oltre la soglia è di
 * un worker crashato a metà lavoro. Se ha ancora tentativi torna `queued` con
 * `attempts + 1` (e `claimed_at` azzerato), altrimenti è un fallimento
 * definitivo — `failed` più `repo_graphs.status = 'failed'`, così la UI vede
 * perché il grafo non si aggiorna più.
 *
 * Due UPDATE distinti (il ramo dipende da `attempts`), nell'ordine
 * fallimento-poi-riaccodamento: il primo filtra su `attempts >= maxAttempts - 1`
 * (l'incremento porterebbe al tetto) e il secondo sui restanti, quindi nessuna
 * riga può cadere in entrambi.
 */
export async function recoverStaleGraphJobs(
  db: Db,
  staleMinutes: number,
  maxAttempts: number,
): Promise<void> {
  const stale = and(
    eq(graphJobs.status, "running"),
    sql`${graphJobs.claimedAt} < now() - make_interval(mins => ${staleMinutes}::int)`,
  );
  const error = `il worker non ha dato segni di vita entro ${staleMinutes} minuti (${maxAttempts} tentativi esauriti)`;

  const failed = await db
    .update(graphJobs)
    .set({
      status: "failed",
      attempts: sql`${graphJobs.attempts} + 1`,
      error,
      updatedAt: sql`now()`,
    })
    .where(and(stale, gte(graphJobs.attempts, maxAttempts - 1)))
    .returning({ repositoryId: graphJobs.repositoryId });

  for (const row of failed) {
    await markRepoGraphFailed(db, row.repositoryId, error);
  }

  await db
    .update(graphJobs)
    .set({
      status: "queued",
      attempts: sql`${graphJobs.attempts} + 1`,
      claimedAt: null,
      updatedAt: sql`now()`,
    })
    .where(and(stale, lt(graphJobs.attempts, maxAttempts - 1)));
}

/**
 * Chiude il job come `done`. Status-guarded su `running`: se nel frattempo è
 * stato riaccodato dal recovery (e magari reclamato altrove) l'UPDATE non tocca
 * righe e non si sovrascrive lo stato di nessuno. NON scrive su `repo_graphs`:
 * i metadati del grafo li aggiorna il runner della build, che è l'unico a
 * conoscerli.
 */
export async function completeGraphJob(db: Db, jobId: string): Promise<void> {
  await db
    .update(graphJobs)
    .set({ status: "done", error: null, updatedAt: sql`now()` })
    .where(and(eq(graphJobs.id, jobId), eq(graphJobs.status, "running")));
}

/**
 * Chiude SOLO il job come `failed` con l'errore (troncato), senza toccare
 * `repo_graphs`. Status-guarded su `running` come completeGraphJob: se il job non
 * è più suo non si scrive nulla. Restituisce il `repositoryId` del job chiuso, o
 * null se non c'era nulla da chiudere.
 *
 * È la variante da usare quando il fallimento NON riguarda il grafo: il job
 * `setup_pr` fallisce (worktree, git, provider) mentre il grafo estratto resta
 * `done` e perfettamente valido — marcarlo `failed` mostrerebbe in UI un grafo
 * rotto che rotto non è. L'errore del setup si legge dallo stato del JOB (che il
 * server espone a parte).
 */
export async function failGraphJobOnly(db: Db, jobId: string, error: string): Promise<string | null> {
  const message = truncateError(error);
  const [job] = await db
    .update(graphJobs)
    .set({ status: "failed", error: message, updatedAt: sql`now()` })
    .where(and(eq(graphJobs.id, jobId), eq(graphJobs.status, "running")))
    .returning({ repositoryId: graphJobs.repositoryId });
  return job?.repositoryId ?? null;
}

/**
 * Chiude il job come `failed` con l'errore (troncato) e riflette il fallimento
 * su `repo_graphs`. Status-guarded su `running` come completeGraphJob: se il job
 * non è più suo non si scrive nulla, nemmeno lo stato del grafo (sarebbe un
 * fallimento fantasma per la UI). Per i fallimenti che NON invalidano il grafo
 * usare {@link failGraphJobOnly}.
 */
export async function failGraphJob(db: Db, jobId: string, error: string): Promise<void> {
  const repositoryId = await failGraphJobOnly(db, jobId, error);
  if (!repositoryId) return;
  await markRepoGraphFailed(db, repositoryId, truncateError(error));
}
