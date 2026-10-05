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
import { comments, users } from "@stubwise/db";
import { plainExcerpt, type CommentReplyTo } from "@stubwise/shared";
import { and, eq, inArray } from "drizzle-orm";

/** `Db` o una transazione drizzle già aperta dal chiamante. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type CommentRow = typeof comments.$inferSelect;

export interface AddCommentInput {
  ticketId: string;
  authorType: CommentRow["authorType"];
  /** Null per i commenti `ai` e `system`, e per un autore eliminato. */
  authorId?: string | null;
  body: string;
  /**
   * Il commento a cui questo risponde (0083). Il chiamante l'ha già validato
   * (stesso ticket): qui si scrive e basta.
   */
  replyToCommentId?: string | null;
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
      replyToCommentId: input.replyToCommentId ?? null,
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

/** Lunghezza dell'estratto nella riga «in risposta a». */
export const REPLY_EXCERPT_CHARS = 120;

/**
 * Il commento a cui ciascuna risposta di un elenco risponde, DERIVATO a
 * lettura (`replyTo` di `ticketCommentSchema` e della variante `comment` di
 * `/activity`): UNA query per elenco, sui soli padri nominati, mai una per
 * commento.
 *
 * Mai copiato nella riga della risposta: se il padre cambia, l'estratto lo
 * segue; se sparisce (`ON DELETE SET NULL`, o una riga non più trovata), la
 * risposta riceve `null` — mai un riferimento a un commento che non c'è.
 * `authorName` è l'email per un autore `user` ancora esistente, `null` per
 * AI, sistema o autore eliminato. Si cercano i padri SOLO fra i commenti di
 * `ticketId`: un legame verso un altro ticket si legge come `null`.
 */
export async function loadReplyTargets(
  db: DbOrTx,
  ticketId: string,
  parentIds: Array<string | null>,
): Promise<Map<string, CommentReplyTo>> {
  const ids = [...new Set(parentIds.filter((id): id is string => id !== null))];
  const out = new Map<string, CommentReplyTo>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: comments.id,
      authorType: comments.authorType,
      body: comments.body,
      email: users.email,
    })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.authorId))
    // Difesa in profondità: il POST rifiuta un padre di un altro ticket, ma
    // una riga scritta da altro codice (o a mano) non deve far uscire qui il
    // corpo di un commento di un altro ticket.
    .where(and(inArray(comments.id, ids), eq(comments.ticketId, ticketId)));
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      authorType: r.authorType,
      authorName: r.authorType === "user" ? r.email : null,
      excerpt: plainExcerpt(r.body, REPLY_EXCERPT_CHARS),
    });
  }
  return out;
}
