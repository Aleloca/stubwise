import { docGenerations, type Db } from "@stubwise/db";
import { and, eq, ne, sql } from "drizzle-orm";

/**
 * Helper di gestione delle generazioni di documentazione (dominio Docs).
 *
 * Storicamente questo modulo conteneva la pipeline PIATTA (map-reduce +
 * capability-pass, `runDocGenerationJob`), sostituita dal motore a DAG ricorsivo
 * (vedi docs/recursive/*). È rimasto `pruneOldGenerations`, riusato dalla
 * finalizzazione del DAG (recursive/finalize.ts) per tenere a freno lo storico delle
 * generazioni del progetto.
 */

/**
 * Pruna le generazioni vecchie del progetto. Regola (semplice e corretta):
 *  - si tiene SEMPRE la corrente (`projects.currentDocGenerationId`), qualunque sia
 *    la sua posizione temporale: MAI prunata, anche se più vecchia di run `failed`
 *    o `held` più recenti (non c'è FK a proteggerla);
 *  - si tiene inoltre la singola generazione più recente DIVERSA dalla corrente,
 *    ordinando per (createdAt DESC, id DESC) — il tiebreaker su `id` rende l'ordine
 *    stabile quando due run condividono lo stesso `createdAt`;
 *  - tutto il resto è eliminato. Non si scende mai sotto "corrente + 1".
 *
 * La cascade FK (onDelete: cascade su doc_pages/doc_chunks) porta via pagine e chunk
 * delle generazioni rimosse. La delete porta comunque un guard `ne(currentId)` come
 * difesa in profondità: la corrente non può finire nel set da eliminare.
 */
export async function pruneOldGenerations(
  db: Db,
  projectId: string,
  currentGenerationId: string,
): Promise<void> {
  const rows = await db
    .select({ id: docGenerations.id })
    .from(docGenerations)
    .where(eq(docGenerations.projectId, projectId))
    .orderBy(sql`${docGenerations.createdAt} DESC`, sql`${docGenerations.id} DESC`);
  // Si tiene la corrente (sempre, autoritativo) + la più recente diversa dalla corrente.
  const keep = new Set<string>([currentGenerationId]);
  for (const r of rows) {
    if (r.id === currentGenerationId) continue;
    keep.add(r.id);
    break; // una sola "altra" generazione, la più recente per (createdAt, id) DESC.
  }
  const toDelete = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  for (const id of toDelete) {
    await db
      .delete(docGenerations)
      .where(and(eq(docGenerations.id, id), ne(docGenerations.id, currentGenerationId)));
  }
}
