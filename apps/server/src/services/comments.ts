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
import { comments, projectDecisions, users } from "@stubwise/db";
import { plainExcerpt, type CommentReplyTo } from "@stubwise/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

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
      deletedAt: comments.deletedAt,
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
      // Un padre eliminato (0084) ha già `body = ''` per il CHECK: l'estratto
      // vuoto si scrive comunque esplicito, così non dipende da quel vincolo.
      excerpt: r.deletedAt === null ? plainExcerpt(r.body, REPLY_EXCERPT_CHARS) : "",
      deleted: r.deletedAt !== null,
    });
  }
  return out;
}

/** Chi guarda un commento: identità e ruolo della sessione. */
export interface CommentViewer {
  id: string;
  role: "admin" | "member";
}

/**
 * LA regola dei permessi su un commento (piano 2026-10-05, decisione 1),
 * pura e UNICA: la usano la proiezione (`canEdit`/`canDelete` nella
 * risposta, per CHI GUARDA) e le rotte PATCH/DELETE, che la traducono nella
 * WHERE del loro UPDATE guardato. Il client legge i due booleani, non li
 * deduce (stesso criterio di `canMerge`).
 *
 * - Solo i commenti `user`: AI e sistema raccontano cosa ha fatto il sistema,
 *   e alcuni servono al funzionamento (`isDroppedRequestNotice`). Il tipo
 *   d'autore viene prima dell'identità: un `ai` con un `authorId` non è tuo.
 * - Modificare: solo l'autore. Un admin NON modifica le parole di un altro.
 * - Cancellare: l'autore o un admin. Un commento `user` con l'autore
 *   eliminato (`authorId` null) lo cancella solo un admin.
 * - Un eliminato non si tocca più (la cancellazione è idempotente sulla rotta,
 *   ma non è un'azione offerta).
 */
export function commentPermissions(
  row: Pick<CommentRow, "authorType" | "authorId" | "deletedAt">,
  viewer: CommentViewer,
): { canEdit: boolean; canDelete: boolean } {
  const touchable = row.authorType === "user" && row.deletedAt === null;
  const own = row.authorId !== null && row.authorId === viewer.id;
  return {
    canEdit: touchable && own,
    canDelete: touchable && (own || viewer.role === "admin"),
  };
}

/**
 * Email di chi ha eliminato ciascun commento dell'elenco (`deletedBy.name`):
 * UNA query sui soli `deletedByUserId` presenti, mai una per commento. Chi
 * non è più fra gli utenti non compare nella mappa (→ `name: null`).
 */
export async function loadDeleterNames(
  db: DbOrTx,
  rows: Array<Pick<CommentRow, "deletedByUserId">>,
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.map((r) => r.deletedByUserId).filter((id): id is string => id !== null)),
  ];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const found = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  for (const u of found) out.set(u.id, u.email);
  return out;
}

/**
 * I commenti dell'elenco il cui testo vive ANCHE nel registro decisioni
 * (`inDecisionLog`, piano L1): le istruzioni di un rifiuto del piano.
 * Cancellare il commento non riscrive la decisione — il registro è di FATTI —
 * e la conferma di «Elimina» deve dirlo.
 *
 * IL LEGAME, senza una colonna: `resolvePlan` (`services/jobs.ts`) scrive il
 * commento `user` e la decisione `plan_review` nella STESSA transazione, col
 * default `now()` su entrambi — che dentro una transazione è l'istante
 * d'inizio, identico per i due insert. Quindi: stessa `ticket_id`, `source =
 * 'plan_review'`, `decided_at = created_at` e lo stesso autore (`IS NOT
 * DISTINCT FROM`: un autore eliminato è NULL da tutte e due le parti, SET
 * NULL su entrambe le FK). Nessun altro percorso scrive un commento `user`
 * in quella transazione. Copre anche i rifiuti già avvenuti, senza backfill;
 * un rifiuto anteriore al registro (fase 5) dà correttamente `false`.
 * ⚠️ Chi cambia `resolvePlan` in modo che i due insert non condividano più
 * l'istante (un `clock_timestamp()` sul commento `user`, una transazione
 * spezzata) rompe questo legame: c'è un test sulla rotta vera.
 *
 * UNA query per elenco, sui soli commenti `user`.
 */
export async function loadDecisionLogLinks(
  db: DbOrTx,
  ticketId: string,
  rows: Array<Pick<CommentRow, "id" | "authorType">>,
): Promise<Set<string>> {
  const ids = rows.filter((r) => r.authorType === "user").map((r) => r.id);
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const found = await db
    .select({ id: comments.id })
    .from(comments)
    .innerJoin(
      projectDecisions,
      and(
        eq(projectDecisions.ticketId, comments.ticketId),
        eq(projectDecisions.source, "plan_review"),
        eq(projectDecisions.decidedAt, comments.createdAt),
        sql`${projectDecisions.decidedByUserId} IS NOT DISTINCT FROM ${comments.authorId}`,
      ),
    )
    .where(and(eq(comments.ticketId, ticketId), inArray(comments.id, ids)));
  for (const r of found) out.add(r.id);
  return out;
}
