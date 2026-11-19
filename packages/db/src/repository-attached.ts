/**
 * Area 9, F6 (0193): un repository senza progetto è STACCATO (il suo progetto
 * è stato eliminato). Lo vede solo l'Amministrazione finché non si ricollega:
 * le rotte di progetto rispondono 404, i lavori di progetto lo saltano.
 * Questa guardia restringe il tipo dove il codice ha bisogno del progetto.
 */
export function isAttachedRepository<T extends { projectId: string | null }>(row: T): row is T & { projectId: string } {
  return row.projectId !== null;
}
