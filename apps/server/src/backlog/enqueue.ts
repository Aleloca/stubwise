/**
 * Deviazione dei ticket verso il backlog di discovery.
 *
 * Sui progetti con `backlogEnabled`, i ticket `feedback`/`feature` NON entrano
 * nella pipeline fix (nessun aiJob): vengono accodati come job `intake` in
 * `backlog_jobs`, che il worker processerà (dedup + metadati suggeriti). Questo
 * helper è l'UNICO punto di decisione: lo chiamano tutti i percorsi di nascita
 * di un ticket (ingest SDK, sorgenti esterne, creazione manuale), dentro la
 * stessa transazione dell'insert del ticket.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@stubwise/db";
import { backlogJobs, projects } from "@stubwise/db";

/**
 * Se il ticket è `feedback`/`feature` e il suo progetto ha `backlogEnabled`,
 * accoda un job `intake` nel backlog e ritorna `true`: il chiamante NON deve
 * accodare l'aiJob della pipeline fix. Altrimenti ritorna `false` (comportamento
 * attuale invariato). Va chiamata nella stessa transazione dell'insert del
 * ticket, così deviazione e ticket sono atomici.
 */
export async function maybeEnqueueBacklogIntake(
  tx: Db,
  ticket: { id: string; projectId: string; type: string },
): Promise<boolean> {
  if (ticket.type !== "feedback" && ticket.type !== "feature") return false;
  const [project] = await tx
    .select({ enabled: projects.backlogEnabled })
    .from(projects)
    .where(eq(projects.id, ticket.projectId));
  if (!project?.enabled) return false;
  await tx
    .insert(backlogJobs)
    .values({ projectId: ticket.projectId, kind: "intake", payload: { ticketId: ticket.id } });
  return true;
}
