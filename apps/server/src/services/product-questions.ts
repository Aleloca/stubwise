import { backlogItems, backlogJobs, docPageCodes, productComments, productPageBlockIds, productPageFollows, productPageRevisions, productPages, projects, tickets, type Db } from "@stubwise/db";
import { freshIds, resolveCatalogRecipients, withAnchorText } from "@stubwise/notifications";
import {
  alertTypeOf,
  anchorIdsOf,
  applyBlockOps,
  blockIdsOf,
  isTextBlock,
  productBlockSchema,
  productBlockWriteSchema,
  productSearchText,
  PRODUCT_BLOCKS_MAX,
  PRODUCT_PAGE_BYTES_MAX,
  validProductBlock,
  type ProductAnswerChoice,
  type ProductBlock,
  type ProductBlockChange,
  type ProductBlockOp,
  type ProductOpenQuestion,
  type ProductQuestion,
  type ProductQuestionAnswer,
  type ProductQuestionView,
  type ProductSourceView,
  type RichText,
} from "@stubwise/shared";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { inProjects, projectIdsWithPermission, projectPermissionsFor, scopeProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { productSourceViews } from "./product-claude.js";
import { ProductDocsError } from "./product-docs.js";
import { ProductQuestionConflictError, close, effectiveAnswer, failedIntakeJobs, namesFor, questionOf } from "./product-question-origin.js";

export { ProductQuestionConflictError, checkProductDocOrigin, closeQuestionWithRequest } from "./product-question-origin.js";
import { holdTouchedSections } from "./product-docs-ops.js";
import { notifyProductRevision } from "./product-live-notify.js";

/**
 * Area 11, F5, Task 4 — le domande di Claude sulla doc di prodotto: come le
 * legge chi guarda, la risposta, le domande aperte. La regola del prototipo
 * (`data/productDocs/questions.ts`):
 * - la domanda la scrive il lavoro del worker (`writeClaudeFacts`): un
 *   commento di Claude col corpo vuoto e la sua parte di domanda; qui si legge
 *   con la fonte VISTA da chi guarda (N-2 = a), mai il riferimento grezzo;
 * - rispondere chiede `docs.edit` nel progetto; UNA risposta: la seconda (un
 *   doppio clic, un'altra persona) è 409 `already_answered` con chi, e non
 *   scrive. Il commento si blocca (`FOR UPDATE`) dopo la pagina, come ogni
 *   scrittura della pagina;
 * - «Update it» (`apply`) scrive la frase del fatto, parola per parola, con
 *   una revisione `edit` a nome di chi risponde e SENZA `via`: nessun segno di
 *   Claude. Se l'ancora è stata toccata dopo la domanda è 409 `changed_after`
 *   (chi): la domanda resta aperta. Le sezioni si prendono come per ogni
 *   scrittura (F4: 409 `section_busy`);
 * - «Keep it» (`keep`) chiude senza revisioni;
 * - «Open a request» (`request`) NON passa da qui: il riquadro di Claude
 *   propone una scheda B, una `createRequest` con `origin.product_doc` e il
 *   `questionId`; confermata, `POST /api/requests` (o il catalogo di Claude)
 *   controlla l'origine PRIMA che la richiesta nasca
 *   ({@link checkProductDocOrigin}) e chiude la domanda nella stessa
 *   transazione del job d'intake ({@link closeQuestionWithRequest}). Il
 *   permesso e il resto sono quelli di `createRequest` di oggi. La voce e il
 *   suo codice si DERIVANO dal risultato del job;
 * - la domanda si chiude rispondendo: «Resolve» e «Reopen» la rifiutano
 *   (`product-comments.ts`);
 * - niente qui scrive nel registro decisioni.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type CommentRow = typeof productComments.$inferSelect;

const ANSWERS: readonly ProductAnswerChoice[] = ["apply", "keep", "request"];

const notFound = () => new ProductDocsError(404, "not_found", "Not found");

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

/** La frase di un'ancora (un blocco di testo o una cella) com'è adesso. */
function anchorRich(blocks: readonly ProductBlock[], anchorId: string): RichText | null {
  const block = blocks.find((b) => anchorIdsOf(b).includes(anchorId));
  if (!block) return null;
  if (block.type === "table") return block.rows.flatMap((r) => r.cells).find((c) => c.id === anchorId)?.content ?? null;
  return isTextBlock(block) && block.id === anchorId ? block.content : null;
}

const touches = (r: Pick<typeof productPageRevisions.$inferSelect, "changes">, anchorId: string) =>
  (r.changes as ProductBlockChange[]).some((c) => c.anchors?.includes(anchorId) || c.blockId === anchorId);

/**
 * La prima revisione che ha toccato l'ancora DOPO la domanda (quella di
 * `changed_after`): dopo il suo `seq`, o, per una domanda senza, dopo la data
 * del commento.
 */
function blockerOf(comment: Pick<CommentRow, "anchorId" | "createdAt">, q: ProductQuestion, revisions: readonly (typeof productPageRevisions.$inferSelect)[]) {
  return revisions.find((r) => (q.seq !== undefined ? r.lastSeq > q.seq : r.createdAt > comment.createdAt) && touches(r, comment.anchorId)) ?? null;
}

/** Le risposte che hanno una strada; il consiglio per primo, se ha la sua. */
function optionsOf(q: ProductQuestion): { recommended: ProductAnswerChoice | null; options: ProductAnswerChoice[] } {
  const has = (o: ProductAnswerChoice) => o === "keep" || (o === "apply" ? q.apply !== null || q.insert !== undefined : q.request !== null);
  const recommended = has(q.recommended) ? q.recommended : null;
  const rest = ANSWERS.filter((o) => o !== recommended && has(o));
  return { recommended, options: recommended ? [recommended, ...rest] : rest };
}

interface PageCtx {
  id: string;
  projectId: string;
  blocks: ProductBlock[];
  perms: ReadonlySet<string> | null;
}

/**
 * Le domande di alcuni commenti radice della STESSA pagina come le legge chi
 * guarda. Un commento senza domanda (o con un jsonb che non passa lo schema)
 * non c'è nella mappa.
 */
async function questionViews(db: Db, viewer: Viewer, pagesById: ReadonlyMap<string, PageCtx>, rows: readonly CommentRow[]): Promise<Map<string, ProductQuestionView>> {
  const out = new Map<string, ProductQuestionView>();
  const failed = await failedIntakeJobs(db, rows);
  const asked = rows.flatMap((r) => {
    const q = r.replyToId === null && r.deletedAt === null && pagesById.has(r.pageId) ? questionOf(r) : null;
    return q ? [{ row: r, q, answer: effectiveAnswer(r, failed), page: pagesById.get(r.pageId)! }] : [];
  });
  if (asked.length === 0) return out;
  const open = asked.filter((a) => a.answer === null && (a.q.apply !== null || a.q.insert !== undefined));
  // Le revisioni di TUTTE le pagine in una lettura (niente N+1).
  const openPages = [...new Set(open.map((a) => a.row.pageId))];
  const revisions = openPages.length > 0 ? await db.select().from(productPageRevisions).where(inArray(productPageRevisions.pageId, openPages)).orderBy(asc(productPageRevisions.lastSeq)) : [];
  const blockers = new Map(open.map((a) => [a.row.id, blockerOf(a.row, a.q, revisions.filter((r) => r.pageId === a.row.pageId))]));
  const sources = await productSourceViews(db, viewer, asked.flatMap((a) => (a.q.sourceRef.kind === "first_version" ? [] : [a.q.sourceRef])));
  // La prima versione (F6) non è una fonte da aprire: solo il suo tipo.
  const sourceOf = (ref: ProductQuestion["sourceRef"]): ProductSourceView =>
    ref.kind === "first_version"
      ? { kind: "first_version", canOpen: false, id: null, title: null, code: null, ownerId: null, ownerName: null, at: null, gone: false, thread: null }
      : sources.get(`${ref.kind}:${ref.id}`)!;
  // «Open a request»: la voce la dice il job d'intake quando ha finito (nuova o fusa), DERIVATA a lettura.
  const jobIds = asked.flatMap((a) => (a.answer?.requestJobId ? [a.answer.requestJobId] : []));
  const jobItem = new Map(
    jobIds.length > 0 ? (await db.select({ id: backlogJobs.id, itemId: backlogJobs.resultItemId }).from(backlogJobs).where(inArray(backlogJobs.id, jobIds))).map((j) => [j.id, j.itemId]) : [],
  );
  const requestOf = (answer: ProductQuestionAnswer) => answer.requestId ?? (answer.requestJobId ? (jobItem.get(answer.requestJobId) ?? null) : null);
  const requestIds = asked.flatMap((a) => (a.answer && requestOf(a.answer) ? [requestOf(a.answer)!] : []));
  const requestCodes = new Map(
    requestIds.length > 0
      ? (await db.select({ id: backlogItems.id, number: backlogItems.number, code: projects.code }).from(backlogItems).innerJoin(projects, eq(projects.id, backlogItems.projectId)).where(inArray(backlogItems.id, requestIds))).map((r) => [r.id, `${r.code}-R${r.number}`])
      : [],
  );
  const taskIds = asked.flatMap((a) => (a.q.reason === "diverges" && a.q.sourceRef.kind === "task" ? [a.q.sourceRef.id] : []));
  const taskCodes = new Map(
    taskIds.length > 0 ? (await db.select({ id: tickets.id, number: tickets.number, code: projects.code }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(inArray(tickets.id, taskIds))).map((r) => [r.id, `${r.code}-${r.number}`]) : [],
  );
  const nameOf = await namesFor(db, viewer, asked.flatMap((a) => [a.q.forId, a.answer?.byId ?? null, blockers.get(a.row.id)?.actorId ?? null]));
  for (const { row, q, answer, page } of asked) {
    const canEdit = page.perms?.has("docs.edit") === true;
    const blocker = blockers.get(row.id) ?? null;
    const forName = nameOf(q.forId);
    const byName = answer ? nameOf(answer.byId) : null;
    const blockerName = blocker ? nameOf(blocker.actorId) : null;
    out.set(row.id, {
      reason: q.reason,
      // R-G5: chi la domanda nomina, solo se chi guarda lo vede.
      forId: forName ? q.forId : null,
      forName,
      taskCode: q.reason === "diverges" && q.sourceRef.kind === "task" ? (taskCodes.get(q.sourceRef.id) ?? null) : null,
      // MAI il riferimento grezzo: la fonte come la vede chi guarda.
      source: sourceOf(q.sourceRef),
      applyMode: q.insert ? "insert" : "replace",
      current: q.insert ? null : anchorRich(page.blocks, row.anchorId),
      apply: q.apply ?? (q.insert && "content" in q.insert.block ? (q.insert.block as { content: RichText }).content : null),
      built: q.built,
      request: q.request,
      ...optionsOf(q),
      canAnswer: answer === null && canEdit,
      applyBlocked: blocker ? { byId: blockerName ? blocker.actorId : null, byName: blockerName } : null,
      answer: answer && {
        byId: byName ? answer.byId : null,
        byName,
        option: answer.option,
        at: answer.at,
        revisionId: answer.revisionId,
        requestId: requestOf(answer),
        requestCode: requestOf(answer) ? (requestCodes.get(requestOf(answer)!) ?? null) : null,
      },
    });
  }
  return out;
}

/** Le pagine coi permessi di chi guarda, in una lettura (i permessi una volta per progetto). */
async function pageCtxs(db: Db, viewer: Viewer, pageIds: readonly string[]): Promise<Map<string, PageCtx>> {
  if (pageIds.length === 0) return new Map();
  const rows = await db.select({ id: productPages.id, projectId: productPages.projectId, blocks: productPages.blocks }).from(productPages).where(inArray(productPages.id, [...new Set(pageIds)]));
  const perms = new Map<string, ReadonlySet<string> | null>();
  for (const r of rows) if (!perms.has(r.projectId)) perms.set(r.projectId, await projectPermissionsFor(db, viewer, r.projectId));
  return new Map(rows.map((r) => [r.id, { id: r.id, projectId: r.projectId, blocks: readBlocks(r.blocks), perms: perms.get(r.projectId) ?? null }]));
}

async function pageCtx(db: Db, viewer: Viewer, pageId: string): Promise<PageCtx | null> {
  const [page] = await db.select({ id: productPages.id, projectId: productPages.projectId, blocks: productPages.blocks }).from(productPages).where(eq(productPages.id, pageId));
  if (!page) return null;
  return { id: page.id, projectId: page.projectId, blocks: readBlocks(page.blocks), perms: await projectPermissionsFor(db, viewer, page.projectId) };
}

/** Le domande dei commenti di una pagina (per `listProductComments`). */
export async function productQuestionViewsOf(db: Db, viewer: Viewer, pageId: string, rows: readonly CommentRow[]): Promise<Map<string, ProductQuestionView>> {
  if (!rows.some((r) => r.question !== null)) return new Map();
  return questionViews(db, viewer, await pageCtxs(db, viewer, [pageId]), rows);
}

export interface ProductAnswerResult {
  /** La revisione di «Update it». */
  revisionId: string | null;
  seq: number | null;
}

/**
 * La risposta a una domanda di Claude, a nome di chi guarda (la rotta ha
 * chiesto `docs.edit`; qui si richiede lo stesso). Tutto in UNA transazione:
 * la pagina, poi il commento, poi la scrittura e la chiusura.
 */
export async function answerProductQuestion(db: Db, viewer: Viewer, commentId: string, option: ProductAnswerChoice): Promise<ProductAnswerResult> {
  // «Open a request» passa da `createRequest` con l'origine della domanda (la scheda B), mai da qui.
  if (option === "request") throw new ProductDocsError(422, "request_via_create_request", "Open a request goes through createRequest with the question as origin");
  const [head] = await db.select({ pageId: productComments.pageId }).from(productComments).where(eq(productComments.id, commentId));
  if (!head) throw notFound();
  const ctx = await pageCtx(db, viewer, head.pageId);
  if (!ctx?.perms?.has("docs.view")) throw notFound();
  if (!ctx.perms.has("docs.edit")) throw new ProductDocsError(403, "forbidden", "Forbidden");
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [page] = await tx.select().from(productPages).where(eq(productPages.id, ctx.id)).for("no key update");
    if (!page) throw notFound();
    const [comment] = await tx.select().from(productComments).where(eq(productComments.id, commentId)).for("update");
    const q = comment && comment.replyToId === null && comment.deletedAt === null ? questionOf(comment) : null;
    if (!comment || !q) throw notFound();
    const prior = effectiveAnswer(comment, await failedIntakeJobs(tx, [comment]));
    if (prior) throw new ProductQuestionConflictError("already_answered", { id: prior.byId, name: (await namesFor(tx, viewer, [prior.byId]))(prior.byId) }, prior.option);
    if (!optionsOf(q).options.includes(option)) throw new ProductDocsError(422, "option_unavailable", "This answer is not available for this question");

    let revisionId: string | null = null;
    let seq: number | null = null;
    if (option === "apply") {
      const later = await tx.select().from(productPageRevisions).where(and(eq(productPageRevisions.pageId, page.id), q.seq !== undefined ? gt(productPageRevisions.lastSeq, q.seq) : undefined)).orderBy(asc(productPageRevisions.lastSeq));
      const blocker = blockerOf(comment, q, later);
      if (blocker) throw new ProductQuestionConflictError("changed_after", { id: blocker.actorId, name: (await namesFor(tx, viewer, [blocker.actorId]))(blocker.actorId) });
      const blocks = readBlocks(page.blocks);
      const op = applyOp(blocks, comment.anchorId, q);
      if (!op) throw new ProductDocsError(422, "invalid_anchor", "The question's sentence isn't on the page");
      // F4: le sezioni toccate si prendono (409 se le ha un altro), sui blocchi di PRIMA.
      await holdTouchedSections(tx, viewer, page.id, blocks, [op]);
      let next: { blocks: ProductBlock[]; changes: ProductBlockChange[] };
      try {
        next = applyBlockOps(blocks, [op]);
      } catch {
        throw new ProductDocsError(422, "invalid_anchor", "The question's sentence isn't on the page");
      }
      if (!next.blocks.every((b) => productBlockWriteSchema.safeParse(b).success && validProductBlock(b))) throw new ProductDocsError(422, "invalid_block", "The answer's block is not valid");
      // I tetti della pagina, come per ogni scrittura di una persona (revisione di F5, 3).
      if (next.blocks.length > PRODUCT_BLOCKS_MAX || Buffer.byteLength(JSON.stringify(next.blocks)) > PRODUCT_PAGE_BYTES_MAX) throw new ProductDocsError(422, "page_too_large", "The page is too large");
      if (next.changes.length > 0) {
        const given = new Set((await tx.select({ id: productPageBlockIds.blockId }).from(productPageBlockIds).where(eq(productPageBlockIds.pageId, page.id))).map((r) => r.id));
        const fresh = next.blocks.flatMap(blockIdsOf).filter((id) => !given.has(id));
        if (fresh.length > 0) await tx.insert(productPageBlockIds).values(fresh.map((blockId) => ({ pageId: page.id, blockId }))).onConflictDoNothing();
        const [updated] = (await tx
          .update(productPages)
          .set({ blocks: next.blocks, searchText: productSearchText(page.title, next.blocks), revSeq: sql`${productPages.revSeq} + 1`, updatedBy: viewer.id, updatedAt: new Date() })
          .where(eq(productPages.id, page.id))
          .returning({ seq: productPages.revSeq })) as [{ seq: number }];
        seq = updated.seq;
        // Una revisione a nome di chi risponde, SENZA `via`: nessun segno di Claude.
        const [rev] = await tx
          .insert(productPageRevisions)
          .values({ pageId: page.id, sessionId: null, seq, lastSeq: seq, actorId: viewer.id, kind: "edit", changes: next.changes as unknown[] })
          .returning({ id: productPageRevisions.id });
        revisionId = rev!.id;
        await notifyProductRevision(tx, { pageId: page.id, seq, kind: "edit", actorId: viewer.id, sessionId: null });
      }
    }
    await close(tx, viewer, comment.id, { option, revisionId, requestJobId: null });
    return { revisionId, seq };
  });
}

/** La scrittura di «Update it»: la frase del fatto al posto di quella dell'ancora, o il blocco nuovo. */
function applyOp(blocks: readonly ProductBlock[], anchorId: string, q: ProductQuestion): ProductBlockOp | null {
  if (q.insert) {
    const afterId = q.insert.afterId === null ? null : (blocks.find((b) => anchorIdsOf(b).includes(q.insert!.afterId!))?.id ?? undefined);
    if (afterId === undefined) return null;
    // Un id nuovo (mai quello del modello): un id non si riusa.
    return { op: "insert", afterId, block: freshIds(q.insert.block as ProductBlock) } as ProductBlockOp;
  }
  const holder = blocks.find((b) => anchorIdsOf(b).includes(anchorId));
  const block = holder && q.apply ? withAnchorText(holder, anchorId, q.apply) : null;
  return block ? ({ op: "set", block } as ProductBlockOp) : null;
}

/**
 * Le domande APERTE a cui chi guarda può rispondere (Home «Decide», il
 * riquadro): radici di Claude senza risposta, non eliminate, nei progetti
 * dove ha `docs.edit` (il filtro nella WHERE), sulle pagine di cui RICEVE le
 * domande (chi segue, o con la riga `product_doc.question` accesa: il
 * catalogo). Chi segue senza `docs.edit` non le ha: non può rispondere.
 * `pageId` restringe a una pagina.
 */
export async function listOpenProductQuestions(db: Db, viewer: Viewer, pageId?: string): Promise<ProductOpenQuestion[]> {
  const editable = await projectIdsWithPermission(db, viewer, "docs.edit");
  // Revisione di F5: i destinatari si filtrano nella WHERE, PRIMA del limite. Chi riceve le domande
  // di un progetto per la riga (iscrizione o default del catalogo) lo dice il catalogo, una volta per
  // progetto; chi segue la pagina, una EXISTS.
  const type = alertTypeOf("product_doc.question")!;
  const rowOn: string[] = [];
  for (const id of await scopeProjectIds(db, editable)) {
    if ((await resolveCatalogRecipients(db, type, id, { projectId: id })).app.includes(viewer.id)) rowOn.push(id);
  }
  const follows = sql`exists (select 1 from ${productPageFollows} f where f.page_id = ${productComments.pageId} and f.user_id = ${viewer.id})`;
  const receives = rowOn.length > 0 ? or(follows, inArray(productPages.projectId, rowOn)) : follows;
  const rows = await db
    .select({ comment: productComments, pageTitle: productPages.title, projectId: productPages.projectId, number: docPageCodes.number, projectCode: projects.code })
    .from(productComments)
    .innerJoin(productPages, eq(productPages.id, productComments.pageId))
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .innerJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    .where(
      and(
        sql`${productComments.question} IS NOT NULL`,
        // La risposta chiude la domanda; un «Open a request» col suo intake FALLITO la riapre (derivato).
        or(isNull(productComments.answer), sql`(${productComments.answer}->>'requestJobId') in (select id::text from backlog_jobs where status = 'failed')`),
        isNull(productComments.deletedAt),
        isNull(productComments.replyToId),
        pageId ? eq(productComments.pageId, pageId) : undefined,
        inProjects(productPages.projectId, editable),
        receives,
      ),
    )
    .orderBy(asc(productComments.createdAt), asc(productComments.id))
    .limit(200);
  const pages = await pageCtxs(db, viewer, rows.map((r) => r.comment.pageId));
  const views = await questionViews(db, viewer, pages, rows.map((r) => r.comment));
  const out: ProductOpenQuestion[] = [];
  for (const r of rows) {
    const question = views.get(r.comment.id);
    // Mai al titolare della fonte (ha agito lui, per mano di Claude), come le card.
    if (!question || (question.source.ownerId !== null && question.source.ownerId === viewer.id)) continue;
    out.push({
      commentId: r.comment.id,
      pageId: r.comment.pageId,
      pageCode: `${r.projectCode}-D${r.number}`,
      pageTitle: r.pageTitle,
      projectId: r.projectId,
      projectCode: r.projectCode,
      anchorId: r.comment.anchorId,
      question,
      createdAt: r.comment.createdAt.toISOString(),
    });
  }
  return out;
}
