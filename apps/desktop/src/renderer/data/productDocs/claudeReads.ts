import { visiblePeopleFor } from "../access/whoCan";
import { docsAccess } from "../docs/reads";
import { heldJobs } from "../instance/queue";
import { CLAUDE_ID, PEOPLE } from "../seed/people";
import { gate, state } from "../store";
import type { AiBlock, AppNotification, ProductPage, ProductRevision } from "../types";
import { threadLink } from "./comments";
import { liveMarks } from "./marks";
import { productPageById } from "./reads";
import { sourceViewOf } from "./sources";

// Le letture del motore di Claude sulla doc di prodotto (11b, Task 2): la
// riga dell'attesa e le due card (`product_doc.updated`,
// `product_doc.question`) come le legge chi riceve. Il motore che scrive sta
// in `claude.ts`.

const nameOf = (personId: string): string =>
  PEOPLE.find((p) => p.id === personId)?.name ?? personId;

/** L'indirizzo della pagina. */
export const productPageHref = (page: ProductPage): string =>
  `#/p/${state.projectsById.get(page.projectId)?.code ?? ""}/docs/product/${page.code}`;


/**
 * Quanti aggiornamenti aspettano il budget o la ripresa della coda nel
 * progetto, e il blocco che vale per il primo (la riga dell'attesa in cima
 * allo spazio, P11). Si conta un aggiornamento per fonte e PAGINA (un lavoro
 * fermo ciascuno): una fonte su due pagine ne conta due. Si contano
 * soltanto: nessuna fonte è nominata. `null` per chi non
 * legge i Docs del progetto (R-G5) o senza attese.
 */
export async function productUpdatesWaiting(
  projectId: string,
): Promise<{ count: number; block: AiBlock } | null> {
  const me = await gate("productDocs.productUpdatesWaiting");
  if (docsAccess(me, projectId) !== "read") return null;
  const jobs = heldJobs().filter(
    (j) =>
      j.kind === "product_doc_update" &&
      j.projectId === projectId &&
      j.productPageId !== undefined &&
      productPageById(j.productPageId) !== undefined,
  );
  return jobs.length === 0 ? null : { count: jobs.length, block: jobs[0]!.block };
}

/** La card non apre più niente: nessun codice, titolo, fonte né link (R-G5). */
function gone(out: AppNotification): void {
  out.objectGone = true;
  out.objectCode = "";
  out.title = "";
  out.body = "";
  out.link = "";
  delete out.actorName;
  delete out.productPageTitle;
  delete out.productCard;
}

/**
 * Chi ha annullato tutte le revisioni della card («↺ Undone by …»): ogni
 * ancora di ognuna è tornata indietro con una revisione `undo` che la
 * nomina (`undoOf`). L'ultimo che ha annullato, se chi guarda lo vede.
 */
function undoneByOf(revisions: readonly ProductRevision[], people: Set<string>): string | null {
  if (revisions.length === 0) return null;
  let last: ProductRevision | null = null;
  for (const r of revisions) {
    const undos = state.productRevisions.filter((u) => u.kind === "undo" && u.undoOf === r.id);
    const back = new Set(undos.flatMap((u) => u.changes.flatMap((c) => c.anchors)));
    if (!r.changes.every((c) => c.anchors.every((a) => back.has(a)))) return null;
    for (const u of undos) if (!last || u.lastSeq > last.lastSeq) last = u;
  }
  return last && people.has(last.actorId) ? nameOf(last.actorId) : null;
}

/**
 * Una `product_doc.updated` come la legge `me` (dentro `listNotifications`,
 * su una copia): il codice e il titolo di adesso della pagina, le fonti
 * nella forma di chi riceve (§21), quante frasi, «per conto di» e chi ha
 * annullato. Pagina che non c'è più, o che `me` non legge, o una riga senza
 * `productUpdate`: `objectGone` e nient'altro.
 */
export function presentProductUpdate(me: string, out: AppNotification): void {
  if (out.kind !== "product_doc.updated") return;
  const ref = out.productUpdate;
  delete out.productUpdate;
  const page = ref ? productPageById(ref.pageId) : undefined;
  if (!ref || !page || docsAccess(me, page.projectId) !== "read") return gone(out);
  out.objectCode = page.code;
  out.link = updateLink(page, ref.revisionIds);
  out.productPageTitle = page.title;
  const revisions = ref.revisionIds.flatMap((id) => state.productRevisions.filter((r) => r.id === id));
  const people = visiblePeopleFor(me);
  const persons = [...new Set(revisions.map((r) => r.actorId))].filter((id) => id !== CLAUDE_ID);
  const onBehalf = ref.sources.length === 1 && persons.length === 1 ? persons[0]! : null;
  out.undoneByName = undoneByOf(revisions, people);
  out.productCard = {
    sources: ref.sources.map((s) => sourceViewOf(me, s, page.projectId)),
    changes: new Set(revisions.flatMap((r) => r.changes.flatMap((c) => c.anchors))).size,
    onBehalfOfName: onBehalf && people.has(onBehalf) ? nameOf(onBehalf) : null,
    waited: ref.waited ?? null,
  };
}

/**
 * Dove porta la card (shape product-claude-mark §3.7): al primo segno di
 * quelle revisioni ancora a vista (`?mark=<ancora>`), altrimenti alla riga
 * della cronologia dell'ultima (`?history=<revisione>`): l'indirizzo porta
 * sempre a ciò che c'è ancora da vedere.
 */
function updateLink(page: ProductPage, revisionIds: readonly string[]): string {
  const mark = liveMarks(page).find((m) => revisionIds.includes(m.revision.id));
  if (mark) return `${productPageHref(page)}?mark=${encodeURIComponent(mark.mark.anchorId)}`;
  const last = revisionIds[revisionIds.length - 1];
  return last ? `${productPageHref(page)}?history=${encodeURIComponent(last)}` : productPageHref(page);
}

/**
 * Una `product_doc.question` come la legge `me`: la pagina e il filo di
 * adesso, la ragione, la persona nominata e chi ha risposto (se li vede), la
 * fonte nella forma di chi riceve. Senza pagina, filo o lettura:
 * `objectGone`.
 */
export function presentProductQuestion(me: string, out: AppNotification): void {
  if (out.kind !== "product_doc.question") return;
  const ref = out.productQuestion;
  delete out.productQuestion;
  const page = ref ? productPageById(ref.pageId) : undefined;
  const comment = ref ? state.productComments.find((c) => c.id === ref.commentId) : undefined;
  const q = comment?.question;
  if (!page || !comment || !q || comment.pageId !== page.id || docsAccess(me, page.projectId) !== "read")
    return gone(out);
  out.objectCode = page.code;
  out.link = threadLink(page, comment.id);
  out.productPageTitle = page.title;
  const people = visiblePeopleFor(me);
  const seen = (id: string | null | undefined) => (id && people.has(id) ? nameOf(id) : null);
  out.productCard = {
    sources: [sourceViewOf(me, q.sourceRef, page.projectId)],
    changes: 0,
    onBehalfOfName: null,
    waited: null,
    question: {
      reason: q.reason,
      forName: seen(q.forId),
      taskCode:
        q.reason === "diverges" && q.sourceRef.kind === "task"
          ? (state.tasksById.get(q.sourceRef.id)?.code ?? null)
          : null,
      answer: q.answer?.option ?? null,
      answeredByName: seen(q.answer?.byId),
    },
  };
}
