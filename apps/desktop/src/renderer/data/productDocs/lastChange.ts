import { state } from "../store";
import type { ProductPage } from "../types";

// L'ultimo cambio di una pagina di Prodotto, in un modulo che dipende solo
// dallo stato: lo leggono lo spazio Prodotto e la pagina iniziale dei Docs
// (`docs/reads.ts`, che `productDocs/reads.ts` importa a sua volta: qui
// nessun giro di import).

/** L'ultima revisione della pagina (per `lastSeq`, ruling P12). */
export function lastRevisionOf(pageId: string): { at: string; actorId: string } | null {
  let last: { lastSeq: number; at: string; actorId: string } | null = null;
  for (const r of state.productRevisions)
    if (r.pageId === pageId && (!last || r.lastSeq > last.lastSeq)) last = r;
  return last ? { at: last.at, actorId: last.actorId } : null;
}

/**
 * L'ultimo «Updated … by …» di una pagina: la sua ultima revisione, come la
 * meta della pagina (`lastRevision`); senza revisioni, la creazione. Uno
 * spostamento di soli blocchi aggiorna `page.updatedAt` ma non è una
 * revisione: nessuna superficie deve dire un autore diverso da un'altra.
 */
export function lastChangeOf(page: ProductPage): { at: string; byId: string } {
  const last = lastRevisionOf(page.id);
  return last ? { at: last.at, byId: last.actorId } : { at: page.createdAt, byId: page.createdById };
}
