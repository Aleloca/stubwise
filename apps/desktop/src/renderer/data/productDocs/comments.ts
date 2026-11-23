import { cleanQuote } from "@stubwise/shared";
import { anchorIdsOf, anchorText } from "../../domain/productDocs/blocks";
import "./alertTypes";
import { personMasker } from "../access/hidden";
import { knownPeopleFor, visiblePeopleFor } from "../access/whoCan";
import { directMentionIds } from "../chat/mentions";
import { docsAccess } from "../docs/reads";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
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
import { questionViewOf } from "./questions";
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


const nameOf = (personId: string): string =>
  PEOPLE.find((p) => p.id === personId)?.name ?? personId;

const commentById = (id: string): ProductComment | undefined =>
  state.productComments.find((c) => c.id === id);

// La frase citata (anche delle domande di Claude, 11b): dall'area 11, F2 la
// regola sta in `@stubwise/shared`, la stessa del server. UNA riga, senza
// spazi ai lati, tagliata a 200 con «…».
export { cleanQuote };

/** L'indirizzo che apre la pagina sul filo (`?comment=<radice>`). */
export const threadLink = (page: ProductPage, rootId: string): string =>
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

/** Un commento come lo legge `me`: una domanda di Claude nella sua vista, mai la fonte grezza (11b). */
/**
 * Il nome di una persona per chi guarda (R-G5): `null` se non la conosce
 * (registro, A11 r.1414: anche disattivati ed ex membri dei progetti visibili
 * si conoscono). Chi guarda e Claude si vedono sempre.
 */
const visibleNameOf = (me: string, personId: string): string | null =>
  personId === me || personId === CLAUDE_ID || knownPeopleFor(me).has(personId) ? nameOf(personId) : null;

/**
 * Il commento come lo legge chi guarda, nella forma del server (F2): senza
 * `seq`, coi nomi che vede, e gli id di chi non conosce come segnaposti
 * (`mask`: quello della risposta intera, r.1414).
 */
export function viewOf(
  me: string,
  page: ProductPage,
  c: ProductComment,
  mask: ReturnType<typeof personMasker> = personMasker(me),
): ProductCommentView {
  // La domanda grezza (fonte, fatto) non esce mai: la sua vista la sostituisce.
  const { question: _question, seq: _seq, ...rest } = copy(c);
  void [_question, _seq];
  return {
    ...rest,
    authorId: mask(c.authorId),
    resolved: c.resolved
      ? { ...c.resolved, byId: mask(c.resolved.byId), byName: visibleNameOf(me, c.resolved.byId) }
      : null,
    authorName: visibleNameOf(me, c.authorId),
    // Le menzionate che chi guarda vede, come il server (review di R11-2, 4).
    mentionIds: c.mentionIds.filter((id) => visibleNameOf(me, id) !== null),
    ...(c.question ? { question: questionViewOf(me, c, page) } : {}),
  };
}

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
  const seqOf = new Map(mine.map((c) => [c.id, c.seq]));
  const mask = personMasker(me);
  const threads = mine
    .filter((c) => c.replyToId === null)
    .map(
      (root): ProductCommentThread => ({
        root: viewOf(me, page, root, mask),
        replies: mine
          .filter((c) => c.replyToId === root.id)
          .sort((a, b) => a.seq - b.seq)
          .map((c) => viewOf(me, page, c, mask)),
        anchorGone: !position.has(root.anchorId),
      }),
    )
    .sort((a, b) => {
      if (a.anchorGone !== b.anchorGone) return a.anchorGone ? 1 : -1;
      const at = a.anchorGone ? 0 : position.get(a.root.anchorId)! - position.get(b.root.anchorId)!;
      return at || seqOf.get(a.root.id)! - seqOf.get(b.root.id)!;
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
 * i Docs). Il titolo salvato è vuoto: la card lo compone in lettura, nella
 * lingua di chi legge, dai valori stabili (`actorName`, codice, titolo di
 * adesso). Il corpo è il testo del commento.
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
      // N-1 = a: chi è menzionato la riceve sempre (obbligo `mentioned`).
      recipientIds: [],
      mandatory: [{ personId, reason: "mentioned" }],
      title: "",
      body: comment.body,
      createdAt: comment.createdAt,
      // Nel catalogo (area 11, D-6 = b): l'ordine con le iscrizioni (R-K19).
      seq: nextSeq(),
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
const posting = new Map<string, Promise<ProductCommentView>>();
/**
 * La chiave del client (come il server, 72 b3ef7fa53): `<persona>|<chiave>`
 * → la pagina e il commento scritto. La stessa chiave dalla stessa persona
 * dà lo stesso commento (nessuna riga né menzione in più); su un'altra
 * pagina è `client_id_reused`. È dell'autore: un altro scrive il suo.
 */
const byClientId = new Map<string, { pageId: string; commentId: string; view: ProductCommentView }>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
onStoreReset(() => {
  posting.clear();
  byClientId.clear();
});

export function addProductComment(
  pageId: string,
  input: { anchorId: string; quote: string; body: string; replyToId?: string; clientId?: string },
): Promise<ProductCommentView> {
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
    .then((me) => {
      // Prima la pagina (chi non la scrive, una pagina che non c'è), poi la chiave (terza revisione, 5).
      const page = editablePage(me, pageId);
      if (input.clientId !== undefined && !UUID.test(input.clientId)) throw invalid("client_id");
      const ck = input.clientId === undefined ? null : `${me}|${input.clientId}`;
      const known = ck === null ? undefined : byClientId.get(ck);
      if (known && known.pageId !== pageId) throw new Error("client_id_reused");
      if (known) {
        // Come il server: la stessa chiave ridà la riga, anche se intanto il commento non c'è più.
        const now = state.productComments.find((c) => c.id === known.commentId);
        return now ? viewOf(me, page, now) : known.view;
      }
      const made = addProductCommentAs(me, pageId, {
        anchorId: input.anchorId,
        quote: input.quote,
        body: input.body,
        ...(input.replyToId !== undefined ? { replyToId: input.replyToId } : {}),
      });
      const view = viewOf(me, page, made);
      if (ck !== null) byClientId.set(ck, { pageId, commentId: made.id, view });
      return view;
    })
    .finally(() => {
      if (posting.get(key) === write) posting.delete(key);
    });
  posting.set(key, write);
  return write;
}

/**
 * La radice di un filo su cui si agisce (`docs.edit`); una risposta è
 * `invalid: reply`. Una domanda di Claude si chiude rispondendo, non con
 * «Resolve»/«Reopen»: `invalid: question` (11b, P18).
 */
function editableRoot(me: string, rootId: string): ProductComment {
  const root = commentById(rootId);
  if (!root) throw notFound();
  editablePage(me, root.pageId);
  if (root.replyToId !== null) throw invalid("reply");
  if (root.question) throw invalid("question");
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
    out.title = "";
    out.body = "";
    out.link = "";
    delete out.actorName;
    return;
  }
  out.objectCode = page.code;
  out.link = threadLink(page, root.id);
  out.productPageTitle = page.title;
  const seen = visiblePeopleFor(me);
  out.mentionNames = directMentionIds(out.body)
    .filter((id) => seen.has(id))
    .map(nameOf);
}
