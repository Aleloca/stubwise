/**
 * Scrittura di un commento sul feed di un ticket.
 *
 * I commenti hanno tre autori possibili (`user`, `ai`, `system`) e nascono da
 * più posti: la rotta `POST /api/tickets/:ticketId/comments` (utente), il
 * worker (AI), e i percorsi automatici del server — webhook git, risoluzione
 * del gate del piano, risposta a una domanda dell'agente — che scrivono
 * `system`. Questo modulo è il punto unico lato server: riceve il `tx` dal
 * chiamante e non ne apre uno proprio, perché un commento di sistema racconta
 * un fatto e deve vivere o morire con la transazione di quel fatto.
 *
 * PERCHÉ `system` E NON `user` PER I COMMENTI AUTOMATICI: `runFix` costruisce
 * il blocco `<indicazioni_del_team>` con i soli commenti `authorType='user'` e
 * lo marca NON FIDATO. Un commento automatico marcato `user` finirebbe lì
 * dentro, insegnando al modello che l'etichetta di fiducia è negoziabile. I
 * commenti `system` restano fuori da quel blocco per costruzione (la query
 * filtra) e servono al FEED umano.
 */

import type { Db } from "@stubwise/db";
import { comments } from "@stubwise/db";

/** `Db` o una transazione drizzle già aperta dal chiamante. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type CommentRow = typeof comments.$inferSelect;

export interface AddCommentInput {
  ticketId: string;
  authorType: CommentRow["authorType"];
  /** Null per i commenti `ai` e `system`, e per un autore eliminato. */
  authorId?: string | null;
  body: string;
}

/**
 * Inserisce un commento e restituisce la riga creata. NON verifica che il
 * ticket esista: lo fa il chiamante, che sa cosa rispondere quando non c'è (la
 * rotta un 404, l'esecuzione di una proposta un `target_gone`). La FK resta la
 * rete di sicurezza.
 */
export async function addComment(tx: DbOrTx, input: AddCommentInput): Promise<CommentRow> {
  const [created] = await tx
    .insert(comments)
    .values({
      ticketId: input.ticketId,
      authorType: input.authorType,
      authorId: input.authorId ?? null,
      body: input.body,
    })
    .returning();
  if (!created) throw new Error("L'insert del commento non ha restituito la riga creata");
  return created;
}

/**
 * Commento AUTOMATICO sul ticket (`authorType: "system"`, nessun autore): la
 * traccia leggibile di un fatto avvenuto senza che una persona abbia scritto
 * nulla — un ticket chiuso al merge, una proposta confermata da una mail.
 */
export async function addSystemComment(
  tx: DbOrTx,
  input: { ticketId: string; body: string },
): Promise<CommentRow> {
  return addComment(tx, { ticketId: input.ticketId, authorType: "system", body: input.body });
}
