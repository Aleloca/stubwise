import { pluginJobs, plugins, type Db, type PluginJob } from "@stubwise/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";

/**
 * CODA `plugin_jobs` — materializzazione di un plugin del registro (`materialize`)
 * e smoke run che verifica che le sue skill siano visibili all'agente (`smoke`).
 *
 * Stessa forma della coda del grafo (`graph/queue.ts`): claim atomico con
 * `FOR UPDATE SKIP LOCKED`, recovery degli orfani sulla soglia di staleness,
 * tentativi massimi prima del fallimento definitivo. Qui ci sono SOLO le
 * transizioni di stato: il poller che le orchestra è a parte.
 *
 * DIFFERENZE rispetto alla coda del grafo:
 *
 * 1. Niente `not_before` (nessun debounce: i job nascono da un'azione admin,
 *    non da un webhook) e niente `updated_at` sul job — la tabella non ce l'ha,
 *    lo storico si legge da `created_at`/`claimed_at`.
 * 2. `attempts` si incrementa nel RECOVERY, non al claim: un job reclamato e
 *    portato a termine nel giro normale non consuma tentativi, che restano
 *    riservati ai riavvii del worker a metà materializzazione.
 * 3. Il riflesso sullo stato OSSERVABILE dipende dal `kind`: `materialize`
 *    scrive `plugins.status`/`error`, `smoke` scrive `plugins.smoke_status`/
 *    `smoke_error`. Sono due assi indipendenti, e confonderli mostrerebbe in UI
 *    un plugin rotto quando a fallire è stato solo lo smoke (o viceversa).
 *
 * INVARIANTI su `plugins` (le stesse di `repo_graphs`, vedi lo schema):
 *  - `error` è non-null SOLO con `status = 'failed'`; `smoke_error` solo con
 *    `smoke_status = 'failed'`. Chi riporta lo stato a buono azzera l'errore.
 *  - `resolved_sha` / `inventory` / `materialized_at` sono l'ultima
 *    materializzazione RIUSCITA (last-known-good) e NON si azzerano su
 *    `failed`: un aggiornamento fallito lascia in uso il pin precedente.
 *  - `updated_at` NON ha `$onUpdate`: ogni UPDATE qui sotto lo valorizza a mano,
 *    altrimenti la colonna resterebbe ferma all'insert.
 */

/** Tentativi massimi di un job del registro prima del fallimento definitivo. */
export const MAX_PLUGIN_ATTEMPTS = 3;

/**
 * Minuti oltre cui un job `running` è considerato orfano di un worker morto.
 *
 * ⚠️ INVARIANTE ARITMETICA, non un numero scelto a occhio:
 *
 *     PLUGIN_STALE_MINUTES > MATERIALIZE_TIMEOUT_MS + VALIDATE_TIMEOUT_MS + margine
 *     (15'                 > 10'                    + 1'                  + 3')
 *
 * Il margine copre il lavoro di filesystem che NON ha un budget proprio
 * (rimozione di `.git`, lettura dell'inventario, `rename` della dir pubblicata).
 * L'invariante è congelata da un test in `poller.test.ts`: chi alza i timeout
 * della materializzazione senza alzare questa soglia lo vede fallire.
 *
 * PERCHÉ È UN INVARIANTE E NON UNA PREFERENZA: l'indice unico parziale su
 * `(plugin_id, kind)` impedisce due job DIVERSI attivi sullo stesso plugin, ma
 * non può nulla contro il recovery, che riaccoda lo STESSO job. Se un
 * materializzatore ancora vivo superasse la soglia, un secondo claimant
 * eseguirebbe lo stesso `job.id`: stessa dir temporanea `.tmp-<jobId>` (quindi
 * `rm` incrociati sulla checkout dell'altro) e chiusure del job che si
 * scavalcano, dato che `failPluginJob` è guarded su `status = 'running'` e non
 * sulla PROPRIETÀ del claim. È questa disuguaglianza — non l'indice — a rendere
 * sicuro il riuso della dir temporanea per id di job.
 */
export const PLUGIN_STALE_MINUTES = 15;

/**
 * Tetto del testo d'errore persistito su `plugin_jobs.error` / `plugins.error` /
 * `plugins.smoke_error`: l'output di `plugin validate` o di un run dell'agente
 * può essere lungo migliaia di righe. Stesso ordine di grandezza della coda del
 * grafo.
 */
export const PLUGIN_ERROR_MAX_CHARS = 4000;

/**
 * Sanitizza un messaggio destinato al DB (e quindi alla UI): redige le
 * credenziali eventualmente presenti in un URL e tronca al tetto.
 *
 * È il CHOKE POINT del registro: ogni scrittura d'errore di questo modulo ci
 * passa, così nessun percorso può dimenticarsene. La redazione ripete quella di
 * `git.ts` di proposito — lì protegge i messaggi di git, qui protegge anche
 * quelli che git non ha prodotto (output di `plugin validate`, output di un run
 * dell'agente, messaggi nostri), che nessun altro guarda.
 */
export function sanitizePluginError(error: string): string {
  const redacted = error.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g, "$1[REDACTED]@");
  return redacted.length > PLUGIN_ERROR_MAX_CHARS
    ? `${redacted.slice(0, PLUGIN_ERROR_MAX_CHARS)}\n[errore troncato]`
    : redacted;
}

/**
 * Riflette il fallimento sullo stato OSSERVABILE del plugin, sull'asse del
 * `kind` del job (vedi il docblock del modulo). L'errore è già sanitizzato dal
 * chiamante.
 */
async function markPluginFailure(
  db: Db,
  pluginId: string,
  kind: PluginJob["kind"],
  error: string,
): Promise<void> {
  const set =
    kind === "smoke"
      ? { smokeStatus: "failed" as const, smokeError: error, updatedAt: sql`now()` }
      : { status: "failed" as const, error, updatedAt: sql`now()` };
  await db.update(plugins).set(set).where(eq(plugins.id, pluginId));
}

/**
 * Reclama atomicamente il job `queued` più vecchio e lo marca `running`. Il
 * claim è un singolo UPDATE con subquery `FOR UPDATE SKIP LOCKED`: due worker
 * concorrenti non prendono mai lo stesso job. Tiebreaker `created_at, id`: due
 * job creati nello stesso istante hanno comunque un ordine stabile.
 *
 * L'indice unico parziale `(plugin_id, kind) WHERE status IN
 * ('queued','running')` garantisce che non esistano due job ATTIVI dello stesso
 * kind sullo stesso plugin: è quello — non il claim — a impedire due
 * materializzazioni concorrenti della stessa directory.
 */
export async function claimNextPluginJob(db: Db): Promise<PluginJob | null> {
  const subquery = sql`(SELECT id FROM plugin_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)`;
  const [job] = await db
    .update(pluginJobs)
    .set({ status: "running", claimedAt: sql`now()` })
    .where(eq(pluginJobs.id, subquery))
    .returning();
  return job ?? null;
}

/**
 * Recupero degli orfani: un job `running` col `claimed_at` oltre la soglia è di
 * un worker crashato a metà lavoro. Se ha ancora tentativi torna `queued` con
 * `attempts + 1` (e `claimed_at` azzerato), altrimenti è un fallimento
 * definitivo — `failed` più il riflesso sull'asse del suo kind, così la UI vede
 * perché il plugin è rimasto in `materializing` (o lo smoke in `pending`).
 *
 * Due UPDATE distinti (il ramo dipende da `attempts`), nell'ordine
 * fallimento-poi-riaccodamento: il primo filtra su `attempts >= maxAttempts - 1`
 * (l'incremento porterebbe al tetto) e il secondo sui restanti, quindi nessuna
 * riga può cadere in entrambi.
 *
 * NOTA sulle directory: un worker morto a metà materializzazione può aver
 * lasciato una checkout parziale sul volume. Non la si tocca qui (è un fatto di
 * filesystem, non di coda): il tentativo successivo riparte da una dir
 * temporanea che ripulisce prima di usare, e la potatura al `ready` rimuove
 * tutto ciò che non è lo sha corrente.
 */
export async function recoverStalePluginJobs(
  db: Db,
  staleMinutes: number,
  maxAttempts: number,
): Promise<void> {
  const stale = and(
    eq(pluginJobs.status, "running"),
    sql`${pluginJobs.claimedAt} < now() - make_interval(mins => ${staleMinutes}::int)`,
  );
  const error = sanitizePluginError(
    `il worker non ha dato segni di vita entro ${staleMinutes} minuti (${maxAttempts} tentativi esauriti)`,
  );

  const failed = await db
    .update(pluginJobs)
    .set({ status: "failed", attempts: sql`${pluginJobs.attempts} + 1`, error })
    .where(and(stale, gte(pluginJobs.attempts, maxAttempts - 1)))
    .returning({ pluginId: pluginJobs.pluginId, kind: pluginJobs.kind });

  for (const row of failed) {
    await markPluginFailure(db, row.pluginId, row.kind, error);
  }

  await db
    .update(pluginJobs)
    .set({ status: "queued", attempts: sql`${pluginJobs.attempts} + 1`, claimedAt: null })
    .where(and(stale, lt(pluginJobs.attempts, maxAttempts - 1)));
}

/**
 * Chiude il job come `done`. Status-guarded su `running`: se nel frattempo è
 * stato riaccodato dal recovery (e magari reclamato altrove) l'UPDATE non tocca
 * righe e non si sovrascrive lo stato di nessuno. NON scrive su `plugins`: lo
 * stato osservabile lo aggiorna il runner, che è l'unico a conoscerlo (`ready`
 * con inventario e sha, oppure `passed` per lo smoke).
 */
export async function completePluginJob(db: Db, jobId: string): Promise<void> {
  await db
    .update(pluginJobs)
    .set({ status: "done", error: null })
    .where(and(eq(pluginJobs.id, jobId), eq(pluginJobs.status, "running")));
}

/**
 * Chiude il job come `failed` con l'errore (sanitizzato) e riflette il
 * fallimento sull'asse del suo kind. Status-guarded su `running` come
 * {@link completePluginJob}: se il job non è più suo non si scrive nulla,
 * nemmeno sullo stato del plugin (sarebbe un fallimento fantasma per la UI).
 */
export async function failPluginJob(db: Db, jobId: string, error: string): Promise<void> {
  const message = sanitizePluginError(error);
  const [job] = await db
    .update(pluginJobs)
    .set({ status: "failed", error: message })
    .where(and(eq(pluginJobs.id, jobId), eq(pluginJobs.status, "running")))
    .returning({ pluginId: pluginJobs.pluginId, kind: pluginJobs.kind });
  if (!job) return;
  await markPluginFailure(db, job.pluginId, job.kind, message);
}
