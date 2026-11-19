import { sql, type SQL } from "drizzle-orm";

/**
 * Area 9, F4 (D-7 = a): la pausa della coda di un progetto, in UN posto. Ogni
 * claim di una coda di lavoro di Claude aggiunge questo frammento alla sua
 * WHERE, risalendo al progetto per la sua strada (ticket, repository…): in
 * pausa, la coda non reclama lavoro NUOVO di quel progetto; il lavoro già
 * partito finisce; nessun lavoro si cancella. Un lavoro senza progetto (null)
 * non si ferma.
 *
 * Agisce SOLO sulla coda di Stubwise: nessun server, ambiente o processo
 * (CLAUDE.md, «Stubwise non fa deploy»). Chat, «Chiedi a Claude» e le
 * sessioni interattive non lo usano, per scelta (D-7).
 *
 * Area 9, F6 (D-8): un progetto archiviato non riceve lavoro, con la stessa
 * regola (il lavoro partito finisce, niente si cancella).
 */
export function projectQueueRunnable(projectId: SQL): SQL {
  // F6 (D-8): un progetto ARCHIVIATO è fermo come uno in pausa, e riaprendolo riparte.
  return sql`NOT EXISTS (SELECT 1 FROM projects qp WHERE qp.id = ${projectId} AND (qp.queue_paused_at IS NOT NULL OR qp.archived_at IS NOT NULL))`;
}

/**
 * Area 9, F6: il progetto NON è archiviato (la pausa non conta). Per i giri
 * che DECIDONO se accodare lavoro nuovo (brief, daily report, polso,
 * attribuzione della posta): un progetto in pausa accoda lo stesso, per non
 * perdere la settimana; un archiviato no. Chi RECLAMA usa
 * {@link projectQueueRunnable}. Le due regole stanno qui, e nessun giro del
 * worker guarda `queue_paused_at` o `archived_at` da sé.
 */
export function projectNotArchived(projectId: SQL): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM projects qa WHERE qa.id = ${projectId} AND qa.archived_at IS NOT NULL)`;
}

/** La stessa regola per una coda che conosce il REPOSITORY: il progetto è quello del repository. */
export function repositoryQueueRunnable(repositoryId: SQL): SQL {
  return projectQueueRunnable(sql`(SELECT qr.project_id FROM repositories qr WHERE qr.id = ${repositoryId})`);
}
