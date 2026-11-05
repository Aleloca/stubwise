import { anchorIdsOf, anchorText } from "../../domain/productDocs/blocks";
import { visiblePeopleFor } from "../access/whoCan";
import { directMentionIds } from "../chat/mentions";
import { docsAccess } from "../docs/reads";
import { PEOPLE } from "../seed/people";
import { getSessionPersonId } from "../session";
import { copy, gate, newId, nextSeq, now, onStoreReset, state } from "../store";
import type {
  AppNotification,
  ProductComment,
  ProductCommentThread,
  ProductCommentView,
  ProductPage,
} from "../types";
import { invalid, notFound, writer } from "../writer";
import { emitProductPage } from "./events";
import { productPageById } from "./reads";
import { editablePage, onAnchorsMerged } from "./writes";

// I commenti delle pagine di prodotto (area 11a, Task 4). Un commento è
// ancorato a un blocco o a una cella (decisione 4): la `quote` ricorda cosa
// si guardava e non si riscrive mai. Le regole:
// - leggere i fili chiede `docs.view`; commentare, rispondere, «Risolto» e
//   «Riapri» chiedono `docs.edit` (`editablePage`, la stessa porta del corpo);
// - un'ancora che non c'è nella pagina ADESSO è `invalid: anchor` per una
//   radice; una risposta va sempre sul filo, anche con l'ancora sparita;
// - un `merge` (Q3) sposta sul blocco unito ogni filo del blocco assorbito,
//   nella stessa scrittura (`onAnchorsMerged`): «Frase eliminata» vale solo
//   per un'ancora davvero tolta, ed è derivata a lettura (`anchorGone`);
// - commentare ed essere menzionati non fanno seguire la pagina
//   (maintainer, 5 nov 2026): `productFollows` non si tocca da qui;
// - ogni persona menzionata che legge i Docs del progetto, diversa da chi
//   scrive, riceve una notifica `product_doc.mention` (Q1). Titolo, corpo e
//   `objectGone` si compongono a lettura (`presentProductMention`).

/** La frase citata: al più 200 caratteri, senza segni. */
const QUOTE_MAX = 200;

const nameOf = (personId: string): string =>
  PEOPLE.find((p) => p.id === personId)?.name ?? personId;

const commentById = (id: string): ProductComment | undefined =>
  state.productComments.find((c) => c.id === id);

/** Senza spazi ai lati e tagliata a `QUOTE_MAX` con «…». */
function cleanQuote(quote: string): string {
  const q = quote.trim();
  return q.length > QUOTE_MAX ? `${q.slice(0, QUOTE_MAX - 1)}…` : q;
}

/** L'indirizzo che apre la pagina sul filo (`?comment=<radice>`). */
const threadLink = (page: ProductPage, rootId: string): string =>
  `#/p/${state.projectsById.get(page.projectId)!.code}/docs/product/${page.code}?comment=${rootId}`;

// --- le ancore dopo un'unione (Q3) ---------------------------------------------

// Registrato una volta, al caricamento del modulo (l'insieme degli ascoltatori
// non si svuota a un ripristino dello store). Radici e risposte si spostano
// insieme; la `quote` resta com'era.
onAnchorsMerged((pageId, from, to) => {
  for (const c of state.productComments)
    if (c.pageId === pageId && c.anchorId === from) c.anchorId = to;
});

// --- leggere -------------------------------------------------------------------

const viewOf = (c: ProductComment): ProductCommentView => ({
  ...copy(c),
  authorName: nameOf(c.authorId),
});

/**
 * I fili di una pagina: aperti e risolti. In ognuno, i fili con l'ancora viva
 * nell'ordine delle ancore nella pagina, poi quelli con l'ancora sparita
 * («Frase eliminata»), per `seq`. Una pagina che chi guarda non vede risponde
 * vuota; una visibile senza `docs.view`, `forbidden`.
 */
export async function listProductComments(
  pageId: string,
): Promise<{ open: ProductCommentThread[]; resolved: ProductCommentThread[] }> {
  const me = await gate("productDocs.listProductComments");
  const empty = { open: [], resolved: [] };
  const page = productPageById(pageId);
  if (!page) return empty;
  const access = docsAccess(me, page.projectId);
  if (access === "forbidden") throw new Error("forbidden");
  if (access === "none") return empty;

  const position = new Map(page.blocks.flatMap(anchorIdsOf).map((id, i) => [id, i]));
  const mine = state.productComments.filter((c) => c.pageId === pageId);
  const threads = mine
    .filter((c) => c.replyToId === null)
    .map(
      (root): ProductCommentThread => ({
        root: viewOf(root),
        replies: mine
          .filter((c) => c.replyToId === root.id)
          .sort((a, b) => a.seq - b.seq)
          .map(viewOf),
        anchorGone: !position.has(root.anchorId),
      }),
    )
    .sort((a, b) => {
      if (a.anchorGone !== b.anchorGone) return a.anchorGone ? 1 : -1;
      const at = a.anchorGone ? 0 : position.get(a.root.anchorId)! - position.get(b.root.anchorId)!;
      return at || a.root.seq - b.root.seq;
    });
  return {
    open: threads.filter((t) => t.root.resolved === null),
    resolved: threads.filter((t) => t.root.resolved !== null),
  };
}

/**
 * Chi si può menzionare in un commento del progetto: chi ne legge i Docs
 * (R-G5) e chi guarda vede, mai Claude né chi scrive. `q` cerca nel nome,
 * senza distinzione di maiuscole. Chi non legge quei Docs non ha candidati.
 */
export async function productMentionCandidates(
  projectId: string,
  q: string,
): Promise<{ id: string; name: string }[]> {
  const me = await gate("productDocs.productMentionCandidates");
  if (docsAccess(me, projectId) !== "read") return [];
  const needle = q.trim().toLowerCase();
  const seen = visiblePeopleFor(me);
  return PEOPLE.filter(
    (p) =>
      !p.isClaude &&
      p.id !== me &&
      seen.has(p.id) &&
      docsAccess(p.id, projectId) === "read" &&
      (!needle || p.name.toLowerCase().includes(needle)),
  ).map((p) => ({ id: p.id, name: p.name }));
}

// --- scrivere ------------------------------------------------------------------

/**
 * Le notifiche di un commento nuovo, una per persona menzionata
 * (`mentionIds` è già senza doppioni, senza chi scrive e senza chi non legge
 * i Docs). Titolo e corpo salvati sono la resa inglese.
 */
function publishMentions(me: string, page: ProductPage, comment: ProductComment): void {
  const rootId = comment.replyToId ?? comment.id;
  for (const personId of comment.mentionIds) {
    state.notifications.push({
      id: newId("n"),
      kind: "product_doc.mention",
      projectId: page.projectId,
      objectCode: page.code,
      departmentId: null,
      recipientIds: [personId],
      title: `${nameOf(me)} mentioned you in ${page.code} · ${page.title}`,
      body: comment.body,
      createdAt: comment.createdAt,
      read: false,
      archived: false,
      snoozedUntil: null,
      link: threadLink(page, rootId),
      actorId: me,
      productComment: { pageId: page.id, rootId },
    });
  }
}

/**
 * Un commento (radice) o una risposta (`replyToId`), per chi ha già passato il
 * cancello. Una risposta prende ancora e frase della sua radice; una radice
 * senza `quote` prende la frase intera dell'ancora.
 */
export function addProductCommentAs(
  me: string,
  pageId: string,
  input: { anchorId: string; quote: string; body: string; replyToId?: string },
): ProductComment {
  const page = editablePage(me, pageId);
  const body = input.body.trim();
  if (!body) throw invalid("body");

  let anchorId: string;
  let quote: string;
  let replyToId: string | null = null;
  if (input.replyToId !== undefined) {
    const root = commentById(input.replyToId);
    if (!root || root.pageId !== page.id) throw notFound();
    if (root.replyToId !== null) throw invalid("reply");
    ({ anchorId, quote } = root);
    replyToId = root.id;
  } else {
    const text = anchorText(page.blocks, input.anchorId);
    if (text === null) throw invalid("anchor");
    anchorId = input.anchorId;
    quote = cleanQuote(input.quote || text);
  }

  const comment: ProductComment = {
    id: newId("pc"),
    pageId: page.id,
    anchorId,
    quote,
    authorId: me,
    body,
    createdAt: now(),
    seq: nextSeq(),
    replyToId,
    resolved: null,
    mentionIds: directMentionIds(body).filter(
      (id) => id !== me && docsAccess(id, page.projectId) === "read",
    ),
  };
  state.productComments.push(comment);
  publishMentions(me, page, comment);
  emitProductPage(page.id, "comments");
  return copy(comment);
}

/**
 * Le scritture in volo per lo stesso commento: un doppio clic su «Comment»
 * (stessa persona, stessa pagina, stessi valori) riceve la stessa scrittura,
 * come `fixRelease`. Finita, lo stesso testo di nuovo è un commento nuovo.
 */
const posting = new Map<string, Promise<ProductComment>>();
onStoreReset(() => posting.clear());

export function addProductComment(
  pageId: string,
  input: { anchorId: string; quote: string; body: string; replyToId?: string },
): Promise<ProductComment> {
  const key = JSON.stringify([
    getSessionPersonId(),
    pageId,
    input.anchorId,
    input.quote,
    input.body,
    input.replyToId ?? null,
  ]);
  const pending = posting.get(key);
  if (pending) return pending;
  const write = writer("productDocs.addProductComment")
    .then((me) => addProductCommentAs(me, pageId, input))
    .finally(() => {
      if (posting.get(key) === write) posting.delete(key);
    });
  posting.set(key, write);
  return write;
}

/** La radice di un filo su cui si agisce (`docs.edit`); una risposta è `invalid: reply`. */
function editableRoot(me: string, rootId: string): ProductComment {
  const root = commentById(rootId);
  if (!root) throw notFound();
  editablePage(me, root.pageId);
  if (root.replyToId !== null) throw invalid("reply");
  return root;
}

/** «Resolve»: il filo va fra i risolti; già risolto, non cambia nulla. */
export async function resolveProductComment(rootId: string): Promise<void> {
  const me = await writer("productDocs.resolveProductComment");
  const root = editableRoot(me, rootId);
  if (root.resolved !== null) return;
  root.resolved = { byId: me, at: now() };
  emitProductPage(root.pageId, "comments");
}

/** «Reopen»: il filo torna fra gli aperti. */
export async function reopenProductComment(rootId: string): Promise<void> {
  const me = await writer("productDocs.reopenProductComment");
  const root = editableRoot(me, rootId);
  if (root.resolved === null) return;
  root.resolved = null;
  emitProductPage(root.pageId, "comments");
}

// --- la notifica a lettura -------------------------------------------------------

/**
 * Una `product_doc.mention` come la legge `me` (dentro `listNotifications`,
 * su una copia): il titolo di adesso della pagina e i nomi menzionati che
 * `me` vede; se la pagina o il filo non ci sono più, o `me` non legge più i
 * Docs del progetto, `objectGone` e nient'altro della pagina — né codice,
 * né titolo, né chi ha scritto, né link (R-G5). Una riga senza
 * `productComment` (nata prima) resta com'è salvata.
 */
export function presentProductMention(me: string, out: AppNotification): void {
  const ref = out.productComment;
  if (out.kind !== "product_doc.mention" || !ref) return;
  const page = productPageById(ref.pageId);
  const root = commentById(ref.rootId);
  delete out.productComment;
  if (!page || !root || root.pageId !== page.id || docsAccess(me, page.projectId) !== "read") {
    out.objectGone = true;
    out.objectCode = "";
    out.title = "A comment you were mentioned in";
    out.body = "This comment is no longer available.";
    out.link = "";
    delete out.actorName;
    return;
  }
  out.objectCode = page.code;
  out.link = threadLink(page, root.id);
  out.productPageTitle = page.title;
  out.title = `${out.actorName ?? "Someone"} mentioned you in ${page.code} · ${page.title}`;
  const seen = visiblePeopleFor(me);
  out.mentionNames = directMentionIds(out.body)
    .filter((id) => seen.has(id))
    .map(nameOf);
}
