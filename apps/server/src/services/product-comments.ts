import { docPageCodes, productComments, productPages, projects, users, type Db } from "@stubwise/db";
import { instancePermissionsOfUser, projectPermissionsByProject, projectViewerIds, publishNotification, userIdsWithPermission } from "@stubwise/notifications";
import {
  anchorIdsOf,
  anchorText,
  cleanQuote,
  productBlockSchema,
  type AddProductCommentInput,
  type ProductBlock,
  type ProductBlockOp,
  type ProductCommentThread,
  type ProductCommentView,
  type ProductCommentsView,
} from "@stubwise/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import { personName } from "./people.js";
import { visiblePersonIds } from "./people-visibility.js";
import { ProductDocsError } from "./product-docs.js";

/**
 * Area 11, F2 — i commenti delle pagine di prodotto. La regola è quella del
 * prototipo (`apps/desktop/src/renderer/data/productDocs/comments.ts`):
 * - leggere i fili chiede `docs.view`, commentare, rispondere, «Resolve» e
 *   «Reopen» `docs.edit` (le rotte lo dichiarano);
 * - una radice va su un'ancora che c'è nella pagina ADESSO (422
 *   `invalid_anchor`); una risposta va sempre sul filo, anche con l'ancora
 *   sparita, e mai sotto un'altra risposta (422 `invalid_reply`);
 * - «Frase eliminata» (`anchorGone`) si DERIVA dai blocchi di adesso, mai da
 *   una colonna; un `merge` sposta i fili del blocco assorbito sul blocco
 *   unito, nella stessa scrittura (`moveMergedAnchors`);
 * - commentare ed essere menzionati non fanno seguire la pagina;
 * - le menzioni sono `@Nome` nel testo, fra chi legge i Docs del progetto,
 *   mai Claude né chi scrive (`productDocReaders`).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type CommentRow = typeof productComments.$inferSelect;

const notFound = () => new ProductDocsError(404, "not_found", "Not found");
const invalid = (code: string, message: string) => new ProductDocsError(422, code, message);

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

/** Chi legge i Docs del progetto adesso (membri con `docs.view` e full admin), coi nomi; mai Claude. */
export async function productDocReaders(db: Db, projectId: string): Promise<{ id: string; name: string }[]> {
  const viewers = new Set(await projectViewerIds(db, projectId));
  const ids = (await userIdsWithPermission(db, "docs.view", projectId)).filter((id) => viewers.has(id));
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(inArray(users.id, [...new Set(ids)]), eq(users.isAgent, false)));
  return rows.map((r) => ({ id: r.id, name: personName(r) }));
}

/**
 * Le persone nominate (`@Nome`) fra `people`; mai chi scrive. I nomi più
 * lunghi prima, e ogni nome trovato CONSUMA il suo tratto di testo (la regola
 * di `mentionedIn` della Chat): «@Ale Loca» non nomina anche «Ale».
 */
export function mentionedIn(text: string, people: readonly { id: string; name: string }[], authorId: string): string[] {
  if (!text.includes("@")) return [];
  let rest = text;
  const out: string[] = [];
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "gu");
    if (!re.test(rest)) continue;
    rest = rest.replace(re, (m) => " ".repeat(m.length));
    if (p.id !== authorId && !out.includes(p.id)) out.push(p.id);
  }
  return out;
}

/** I commenti come li legge chi guarda: i nomi solo di chi vede (R-G5), le menzioni che vede. */
async function viewsOf(db: Db, viewer: Viewer, rows: readonly CommentRow[]): Promise<Map<string, ProductCommentView>> {
  const people = await visiblePersonIds(db, viewer);
  const sees = (id: string | null): id is string => id !== null && (people === "all" || people.includes(id));
  const named = [...new Set(rows.flatMap((r) => [r.authorId, r.resolvedBy]).filter(sees))];
  const names = new Map(
    named.length > 0 ? (await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, named))).map((u) => [u.id, personName(u)]) : [],
  );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        pageId: r.pageId,
        anchorId: r.anchorId,
        quote: r.quote,
        authorId: r.authorId,
        authorName: sees(r.authorId) ? (names.get(r.authorId) ?? null) : null,
        body: r.body,
        createdAt: r.createdAt.toISOString(),
        replyToId: r.replyToId,
        resolved: r.resolvedAt ? { byId: r.resolvedBy, byName: sees(r.resolvedBy) ? (names.get(r.resolvedBy) ?? null) : null, at: r.resolvedAt.toISOString() } : null,
        mentionIds: r.mentions.filter(sees),
        // F5: la parte di domanda la legge `product-questions.ts` (Task 4).
        question: null,
      },
    ]),
  );
}

/**
 * I fili di una pagina (la rotta ha già chiesto `docs.view`): aperti e
 * risolti. In ognuno, i fili con l'ancora viva nell'ordine delle ancore nella
 * pagina, poi quelli con l'ancora sparita («Frase eliminata»), dal più vecchio.
 * Un commento eliminato non si mostra (e con lui le sue risposte).
 */
export async function listProductComments(db: Db, viewer: Viewer, pageId: string): Promise<ProductCommentsView> {
  const [page] = await db.select({ blocks: productPages.blocks }).from(productPages).where(eq(productPages.id, pageId));
  if (!page) throw notFound();
  const rows = await db
    .select()
    .from(productComments)
    .where(and(eq(productComments.pageId, pageId), isNull(productComments.deletedAt)))
    .orderBy(asc(productComments.createdAt), asc(productComments.id));
  const views = await viewsOf(db, viewer, rows);
  const position = new Map(readBlocks(page.blocks).flatMap(anchorIdsOf).map((id, i) => [id, i]));
  const order = new Map(rows.map((r, i) => [r.id, i]));
  // Le risposte raggruppate UNA volta per radice (review di F2), già in ordine.
  const repliesOf = new Map<string, ProductCommentView[]>();
  for (const r of rows) if (r.replyToId !== null) repliesOf.set(r.replyToId, [...(repliesOf.get(r.replyToId) ?? []), views.get(r.id)!]);
  const threads = rows
    .filter((r) => r.replyToId === null)
    .map(
      (root): ProductCommentThread => ({
        root: views.get(root.id)!,
        replies: repliesOf.get(root.id) ?? [],
        // DERIVATO: l'ancora non c'è nei blocchi di adesso.
        anchorGone: !position.has(root.anchorId),
      }),
    )
    .sort((a, b) => {
      if (a.anchorGone !== b.anchorGone) return a.anchorGone ? 1 : -1;
      const at = a.anchorGone ? 0 : position.get(a.root.anchorId)! - position.get(b.root.anchorId)!;
      return at || order.get(a.root.id)! - order.get(b.root.id)!;
    });
  return { open: threads.filter((t) => t.root.resolved === null), resolved: threads.filter((t) => t.root.resolved !== null) };
}

export interface AddedProductComment {
  view: ProductCommentView;
  /** Le persone menzionate (lettori dei Docs, mai chi scrive): i destinatari di `product_doc.mention` (Task 3). */
  mentioned: string[];
  projectId: string;
}

/**
 * Un commento (radice) o una risposta (`replyToId`), per chi ha `docs.edit`
 * (la rotta). Una risposta prende ancora e frase della sua radice; una radice
 * senza `quote` prende la frase intera dell'ancora. Sotto il lock della riga
 * della pagina: l'ancora si controlla sui blocchi che nessuno sta scrivendo.
 */
export async function addProductComment(db: Db, viewer: Viewer, pageId: string, input: AddProductCommentInput): Promise<AddedProductComment> {
  const body = input.body.trim();
  if (!body) throw invalid("invalid_body", "The comment is empty");
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [page] = await tx.select({ id: productPages.id, projectId: productPages.projectId, blocks: productPages.blocks }).from(productPages).where(eq(productPages.id, pageId)).for("no key update");
    if (!page) throw notFound();
    let anchorId: string;
    let quote: string;
    let replyToId: string | null = null;
    if (input.replyToId !== undefined) {
      const [root] = await tx
        .select()
        .from(productComments)
        .where(and(eq(productComments.id, input.replyToId), eq(productComments.pageId, page.id), isNull(productComments.deletedAt)));
      if (!root) throw notFound();
      if (root.replyToId !== null) throw invalid("invalid_reply", "A reply goes under the first comment of the thread");
      ({ anchorId, quote } = root);
      replyToId = root.id;
    } else {
      const text = anchorText(readBlocks(page.blocks), input.anchorId);
      if (text === null) throw invalid("invalid_anchor", "The comment's block isn't on the page");
      anchorId = input.anchorId;
      // Review di F2 (M5): la frase citata dev'essere DEL blocco. Una frase che il
      // blocco non contiene (inventata), o vuota, diventa il testo dell'ancora:
      // dopo «Frase eliminata» la citazione è l'unica cosa che resta del blocco.
      const whole = cleanQuote(text);
      const given = cleanQuote(input.quote);
      const oneLine = text.replace(/\s+/g, " ").trim();
      quote = given !== "" && oneLine.includes(given.endsWith("…") ? given.slice(0, -1) : given) ? given : whole;
    }
    const mentioned = mentionedIn(body, await productDocReaders(tx, page.projectId), viewer.id);
    const [row] = await tx.insert(productComments).values({ pageId: page.id, anchorId, quote, replyToId, body, authorId: viewer.id, mentions: mentioned }).returning();
    if (mentioned.length > 0) await publishMention(tx, viewer, page, row!.id, mentioned);
    const view = (await viewsOf(tx, viewer, [row!])).get(row!.id)!;
    return { view, mentioned, projectId: page.projectId };
  });
}

/**
 * Task 3: una card `product_doc.mention` per ogni persona menzionata, nella
 * transazione del commento. Il catalogo la manda SOLO agli obbligatori
 * (`mentioned`), a chi legge i Docs del progetto adesso (`seePerm`), mai a chi
 * scrive (`exclude`). Nel jsonb solo id, codici e il nome di chi ha scritto:
 * titolo, codice di adesso, chi ha menzionato (R-G5) e `objectGone` li deriva
 * l'inbox a lettura (`productDocCardsFor`).
 */
async function publishMention(tx: Db, viewer: Viewer, page: { id: string; projectId: string }, commentId: string, mentioned: readonly string[]): Promise<void> {
  const [code] = await tx
    .select({ number: docPageCodes.number, projectCode: projects.code })
    .from(docPageCodes)
    .innerJoin(projects, eq(projects.id, docPageCodes.projectId))
    .where(eq(docPageCodes.productPageId, page.id));
  const [author] = await tx.select({ email: users.email, displayName: users.displayName }).from(users).where(eq(users.id, viewer.id));
  await publishNotification(
    tx,
    {
      kind: "product_doc.mention",
      pageId: page.id,
      pageCode: code ? `${code.projectCode}-D${code.number}` : "",
      projectId: page.projectId,
      projectCode: code?.projectCode ?? "",
      commentId,
      authorUserId: viewer.id,
      authorName: author ? personName(author) : "",
    },
    { projectId: page.projectId, mandatory: mentioned.map((userId) => ({ userId, reason: "mentioned" as const })), exclude: [viewer.id] },
  );
}

/**
 * «Resolve» / «Reopen» di un filo (`docs.edit`, la rotta). Solo una radice
 * (una risposta 422 `invalid_reply`); già nello stato chiesto, niente cambia.
 */
export async function setProductCommentResolved(db: Db, viewer: Viewer, rootId: string, resolved: boolean): Promise<void> {
  const [root] = await db.select().from(productComments).where(and(eq(productComments.id, rootId), isNull(productComments.deletedAt)));
  if (!root) throw notFound();
  if (root.replyToId !== null) throw invalid("invalid_reply", "Only a thread's first comment is resolved");
  if ((root.resolvedAt !== null) === resolved) return;
  await db
    .update(productComments)
    .set(resolved ? { resolvedAt: new Date(), resolvedBy: viewer.id } : { resolvedAt: null, resolvedBy: null })
    .where(eq(productComments.id, rootId));
}

/** La pagina di un commento (per la rotta che lo risolve: il suo progetto). */
export async function productCommentPage(db: Db, commentId: string): Promise<string | null> {
  const [row] = await db.select({ pageId: productComments.pageId }).from(productComments).where(eq(productComments.id, commentId));
  return row?.pageId ?? null;
}

/**
 * Le persone che `viewer` può menzionare nel progetto (la rotta ha chiesto
 * `docs.view`): chi ne legge i Docs e chi guarda vede, mai Claude né sé
 * stesso. `q` cerca nel nome, senza maiuscole.
 */
export async function productMentionCandidates(db: Db, viewer: Viewer, projectId: string, q: string): Promise<{ id: string; name: string }[]> {
  const needle = q.trim().toLowerCase();
  const people = await visiblePersonIds(db, viewer);
  return (await productDocReaders(db, projectId))
    .filter((p) => p.id !== viewer.id && (people === "all" || people.includes(p.id)) && (!needle || p.name.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 50);
}

/**
 * Un `merge` sposta sul blocco unito ogni filo del blocco assorbito (radici e
 * risposte; la frase resta com'era), nella transazione della scrittura. Le
 * operazioni nell'ordine dato: A+B e poi Z+A portano i fili di B su Z. Ogni
 * filo spostato ricorda dov'era nato (`original_anchor_id`, review di F2 M4),
 * per tornarci col ⌘Z ({@link restoreMergedAnchors}).
 */
export async function moveMergedAnchors(tx: Db, pageId: string, ops: readonly ProductBlockOp[]): Promise<void> {
  for (const op of ops) {
    if (op.op !== "merge") continue;
    await tx
      .update(productComments)
      .set({ anchorId: op.firstId, originalAnchorId: sql`coalesce(${productComments.originalAnchorId}, ${op.secondId})` })
      .where(and(eq(productComments.pageId, pageId), eq(productComments.anchorId, op.secondId)));
  }
}

/**
 * Il ⌘Z rimette dei blocchi tolti (`undoOf`, F1): i fili nati su uno di loro e
 * spostati da un `merge` tornano su quel blocco (review di F2 M4). Gli altri
 * fili, nati sul blocco che ha assorbito, restano dove sono.
 */
export async function restoreMergedAnchors(tx: Db, pageId: string, restoredIds: readonly string[]): Promise<void> {
  if (restoredIds.length === 0) return;
  await tx
    .update(productComments)
    .set({ anchorId: productComments.originalAnchorId, originalAnchorId: null })
    .where(and(eq(productComments.pageId, pageId), inArray(productComments.originalAnchorId, [...restoredIds])));
}

/**
 * Una card della doc di prodotto come la legge chi guarda, DERIVATA a lettura.
 * Per una menzione c'è il commento; per `updated` e `question` (prodotte da F5)
 * solo la pagina, e i campi del commento sono null.
 */
export interface ProductDocCard {
  pageId: string;
  pageCode: string;
  /** Il titolo di ADESSO della pagina. */
  pageTitle: string;
  projectCode: string;
  commentId: string | null;
  /** La radice del filo (il commento stesso, o quello a cui risponde): per aprire la pagina sul filo. */
  threadRootId: string | null;
  authorId: string | null;
  /** Chi ha menzionato, solo se chi guarda lo vede (R-G5). */
  authorName: string | null;
  /**
   * Il testo del commento di ADESSO, al più 200 caratteri (come `chat.excerpt`),
   * dalla riga del commento, mai dal jsonb; null su `updated` e `question`
   * (richiesta di 46 dalla review di R11-2: nel prototipo il corpo della card).
   */
  excerpt: string | null;
}

/**
 * Review di F3 (M3): al più 200 caratteri, tagliati per CODE POINT (un emoji
 * non si spezza a metà della coppia surrogata), come `chat.excerpt`.
 */
function excerptOf(body: string): string {
  const points = Array.from(body);
  return points.length > 200 ? `${points.slice(0, 199).join("").trimEnd()}…` : body;
}

/**
 * Le card della doc di prodotto di una pagina d'inbox (tutti e tre i kind),
 * coi dati di ADESSO (mai dal jsonb, che porta solo gli id): titolo e codice
 * della pagina e, per una menzione, il commento e chi l'ha scritto (R-G5).
 * `null` = `objectGone`: la pagina non c'è più, il commento di una menzione
 * non c'è più (o non è di quella pagina), o chi guarda non legge più i Docs di
 * quel progetto. Una query per tabella e una per i permessi, non una per card.
 */
export async function productDocCardsFor(db: Db, viewerId: string, rows: readonly { id: string; kind: string; event: unknown }[]): Promise<Map<string, ProductDocCard | null>> {
  const out = new Map<string, ProductDocCard | null>();
  const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
  const wanted = rows.flatMap((r) => {
    const e = (r.event ?? {}) as { pageId?: unknown; commentId?: unknown };
    const needsComment = r.kind === "product_doc.mention";
    if (!isId(e.pageId) || (needsComment && !isId(e.commentId))) {
      out.set(r.id, null);
      return [];
    }
    return [{ id: r.id, pageId: e.pageId, commentId: needsComment ? (e.commentId as string) : null }];
  });
  if (wanted.length === 0) return out;
  const pages = await db
    .select({ id: productPages.id, projectId: productPages.projectId, title: productPages.title, number: docPageCodes.number, projectCode: projects.code })
    .from(productPages)
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .innerJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    .where(inArray(productPages.id, [...new Set(wanted.map((w) => w.pageId))]));
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const commentIds = [...new Set(wanted.flatMap((w) => (w.commentId ? [w.commentId] : [])))];
  const commentRows =
    commentIds.length > 0
      ? await db
          .select({ id: productComments.id, pageId: productComments.pageId, replyToId: productComments.replyToId, authorId: productComments.authorId, body: productComments.body })
          .from(productComments)
          .where(and(inArray(productComments.id, commentIds), isNull(productComments.deletedAt)))
      : [];
  const commentById = new Map(commentRows.map((c) => [c.id, c]));
  const perms = await projectPermissionsByProject(db, viewerId, pages.map((p) => p.projectId));
  const people = await visiblePersonIds(db, { id: viewerId, instancePermissions: await instancePermissionsOfUser(db, viewerId) });
  const authors = [...new Set(commentRows.flatMap((c) => (c.authorId && (people === "all" || people.includes(c.authorId)) ? [c.authorId] : [])))];
  const names = new Map(
    authors.length > 0 ? (await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, authors))).map((u) => [u.id, personName(u)]) : [],
  );
  for (const w of wanted) {
    const page = pageById.get(w.pageId);
    const comment = w.commentId ? commentById.get(w.commentId) : undefined;
    const reads = page ? perms.get(page.projectId)?.has("docs.view") === true : false;
    if (!page || !reads || (w.commentId !== null && (!comment || comment.pageId !== page.id))) {
      out.set(w.id, null);
      continue;
    }
    out.set(w.id, {
      pageId: page.id,
      pageCode: `${page.projectCode}-D${page.number}`,
      pageTitle: page.title,
      projectCode: page.projectCode,
      commentId: comment?.id ?? null,
      threadRootId: comment ? (comment.replyToId ?? comment.id) : null,
      authorId: comment?.authorId ?? null,
      authorName: comment?.authorId ? (names.get(comment.authorId) ?? null) : null,
      // Un commento eliminato non ha testo (e qui non arriva: è `objectGone`); un corpo vuoto resta null.
      excerpt: comment && comment.body !== "" ? excerptOf(comment.body) : null,
    });
  }
  return out;
}
