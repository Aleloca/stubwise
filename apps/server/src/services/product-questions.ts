import { backlogItems, createRequestItem, docPageCodes, productComments, productPageBlockIds, productPageRevisions, productPages, projects, tickets, users, type Db } from "@stubwise/db";
import { withAnchorText } from "@stubwise/notifications";
import {
  anchorIdsOf,
  applyBlockOps,
  blockIdsOf,
  isTextBlock,
  productBlockSchema,
  productBlockWriteSchema,
  productQuestionAnswerSchema,
  productQuestionSchema,
  productSearchText,
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
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { inProjects, projectIdsWithPermission, projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { personName } from "./people.js";
import { visiblePersonIds } from "./people-visibility.js";
import { productSourceViews } from "./product-claude.js";
import { ProductDocsError } from "./product-docs.js";
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
 * - «Open a request» (`request`) crea la voce del backlog (`createRequestItem`,
 *   lo scrittore delle persone) e la chiude nella stessa transazione. Chiede
 *   `backlog.create` e il backlog acceso nel progetto: senza, l'opzione non
 *   c'è (`options`) e la risposta è 422 `option_unavailable`;
 * - la domanda si chiude rispondendo: «Resolve» e «Reopen» la rifiutano
 *   (`product-comments.ts`);
 * - niente qui scrive nel registro decisioni.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type CommentRow = typeof productComments.$inferSelect;

const ANSWERS: readonly ProductAnswerChoice[] = ["apply", "keep", "request"];

const notFound = () => new ProductDocsError(404, "not_found", "Not found");

/** 409: la domanda ha già una risposta (`already_answered`), o la frase è cambiata dopo (`changed_after`). */
export class ProductQuestionConflictError extends ProductDocsError {
  constructor(
    readonly reason: "already_answered" | "changed_after",
    readonly by: { id: string | null; name: string | null },
    readonly option: ProductAnswerChoice | null = null,
  ) {
    super(409, reason, reason === "already_answered" ? "The question already has an answer" : "The sentence changed after the question");
  }
}

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

const questionOf = (row: Pick<CommentRow, "question">): ProductQuestion | null => {
  const parsed = row.question ? productQuestionSchema.safeParse(row.question) : null;
  return parsed?.success ? parsed.data : null;
};

const answerOf = (row: Pick<CommentRow, "answer">): ProductQuestionAnswer | null => {
  const parsed = row.answer ? productQuestionAnswerSchema.safeParse(row.answer) : null;
  return parsed?.success ? parsed.data : null;
};

/** I nomi delle persone che chi guarda vede (R-G5). */
async function namesFor(db: Db, viewer: Viewer, ids: readonly (string | null)[]): Promise<(id: string | null) => string | null> {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null))];
  if (wanted.length === 0) return () => null;
  const people = await visiblePersonIds(db, viewer);
  const rows = await db.select({ id: users.id, email: users.email, displayName: users.displayName, isAgent: users.isAgent }).from(users).where(inArray(users.id, wanted));
  const names = new Map(rows.map((u) => [u.id, { name: personName(u), agent: u.isAgent }]));
  return (id) => {
    const u = id ? names.get(id) : undefined;
    // Claude si nomina sempre; una persona solo se chi guarda la vede.
    return u && (u.agent || people === "all" || people.includes(id!)) ? u.name : null;
  };
}

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
function optionsOf(q: ProductQuestion, canRequest: boolean): { recommended: ProductAnswerChoice | null; options: ProductAnswerChoice[] } {
  const has = (o: ProductAnswerChoice) => o === "keep" || (o === "apply" ? q.apply !== null || q.insert !== undefined : q.request !== null && canRequest);
  const recommended = has(q.recommended) ? q.recommended : null;
  const rest = ANSWERS.filter((o) => o !== recommended && has(o));
  return { recommended, options: recommended ? [recommended, ...rest] : rest };
}

interface PageCtx {
  id: string;
  projectId: string;
  blocks: ProductBlock[];
  perms: ReadonlySet<string> | null;
  backlogEnabled: boolean;
}

const canRequestIn = (page: PageCtx) => page.backlogEnabled && page.perms?.has("backlog.create") === true;

/**
 * Le domande di alcuni commenti radice della STESSA pagina come le legge chi
 * guarda. Un commento senza domanda (o con un jsonb che non passa lo schema)
 * non c'è nella mappa.
 */
async function questionViews(db: Db, viewer: Viewer, page: PageCtx, rows: readonly CommentRow[]): Promise<Map<string, ProductQuestionView>> {
  const out = new Map<string, ProductQuestionView>();
  const asked = rows.flatMap((r) => {
    const q = r.replyToId === null && r.deletedAt === null ? questionOf(r) : null;
    return q ? [{ row: r, q, answer: answerOf(r) }] : [];
  });
  if (asked.length === 0) return out;
  const open = asked.filter((a) => a.answer === null && (a.q.apply !== null || a.q.insert !== undefined));
  const revisions = open.length > 0 ? await db.select().from(productPageRevisions).where(eq(productPageRevisions.pageId, page.id)).orderBy(asc(productPageRevisions.lastSeq)) : [];
  const blockers = new Map(open.map((a) => [a.row.id, blockerOf(a.row, a.q, revisions)]));
  const sources = await productSourceViews(db, viewer, asked.flatMap((a) => (a.q.sourceRef.kind === "first_version" ? [] : [a.q.sourceRef])));
  // La prima versione (F6) non è una fonte da aprire: solo il suo tipo.
  const sourceOf = (ref: ProductQuestion["sourceRef"]): ProductSourceView =>
    ref.kind === "first_version"
      ? { kind: "first_version", canOpen: false, id: null, title: null, code: null, ownerId: null, ownerName: null, at: null, gone: false, thread: null }
      : sources.get(`${ref.kind}:${ref.id}`)!;
  const requestIds = asked.flatMap((a) => (a.answer?.requestId ? [a.answer.requestId] : []));
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
  const canEdit = page.perms?.has("docs.edit") === true;
  for (const { row, q, answer } of asked) {
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
      ...optionsOf(q, canRequestIn(page)),
      canAnswer: answer === null && canEdit,
      applyBlocked: blocker ? { byId: blockerName ? blocker.actorId : null, byName: blockerName } : null,
      answer: answer && {
        byId: byName ? answer.byId : null,
        byName,
        option: answer.option,
        at: answer.at,
        revisionId: answer.revisionId,
        requestId: answer.requestId,
        requestCode: answer.requestId ? (requestCodes.get(answer.requestId) ?? null) : null,
      },
    });
  }
  return out;
}

async function pageCtx(db: Db, viewer: Viewer, pageId: string): Promise<PageCtx | null> {
  const [page] = await db
    .select({ id: productPages.id, projectId: productPages.projectId, blocks: productPages.blocks, backlogEnabled: projects.backlogEnabled })
    .from(productPages)
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .where(eq(productPages.id, pageId));
  if (!page) return null;
  return { id: page.id, projectId: page.projectId, blocks: readBlocks(page.blocks), perms: await projectPermissionsFor(db, viewer, page.projectId), backlogEnabled: page.backlogEnabled };
}

/** Le domande dei commenti di una pagina (per `listProductComments`). */
export async function productQuestionViewsOf(db: Db, viewer: Viewer, pageId: string, rows: readonly CommentRow[]): Promise<Map<string, ProductQuestionView>> {
  if (!rows.some((r) => r.question !== null)) return new Map();
  const page = await pageCtx(db, viewer, pageId);
  return page ? questionViews(db, viewer, page, rows) : new Map();
}

export interface ProductAnswerResult {
  /** La revisione di «Update it». */
  revisionId: string | null;
  seq: number | null;
  /** La voce del backlog di «Open a request». */
  requestId: string | null;
}

/**
 * La risposta a una domanda di Claude, a nome di chi guarda (la rotta ha
 * chiesto `docs.edit`; qui si richiede lo stesso). Tutto in UNA transazione:
 * la pagina, poi il commento, poi la scrittura e la chiusura.
 */
export async function answerProductQuestion(db: Db, viewer: Viewer, commentId: string, option: ProductAnswerChoice): Promise<ProductAnswerResult> {
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
    const prior = answerOf(comment);
    if (prior) throw new ProductQuestionConflictError("already_answered", { id: prior.byId, name: (await namesFor(tx, viewer, [prior.byId]))(prior.byId) }, prior.option);
    if (!optionsOf(q, canRequestIn(ctx)).options.includes(option)) throw new ProductDocsError(422, "option_unavailable", "This answer is not available for this question");

    let revisionId: string | null = null;
    let seq: number | null = null;
    let requestId: string | null = null;
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
    } else if (option === "request") {
      requestId = await createRequestItem(tx, { projectId: page.projectId, title: q.request!.title, document: q.request!.description, requesterId: viewer.id });
    }
    const answer: ProductQuestionAnswer = { byId: viewer.id, option, at: new Date().toISOString(), revisionId, requestId };
    await tx
      .update(productComments)
      .set({ answer: answer as unknown as Record<string, unknown>, resolvedAt: new Date(), resolvedBy: viewer.id })
      .where(eq(productComments.id, comment.id));
    return { revisionId, seq, requestId };
  });
}

/** La scrittura di «Update it»: la frase del fatto al posto di quella dell'ancora, o il blocco nuovo. */
function applyOp(blocks: readonly ProductBlock[], anchorId: string, q: ProductQuestion): ProductBlockOp | null {
  if (q.insert) {
    const afterId = q.insert.afterId === null ? null : (blocks.find((b) => anchorIdsOf(b).includes(q.insert!.afterId!))?.id ?? undefined);
    if (afterId === undefined) return null;
    // Un id nuovo (mai quello del modello): un id non si riusa.
    return { op: "insert", afterId, block: { ...q.insert.block, id: `blk-${randomUUID()}` } } as ProductBlockOp;
  }
  const holder = blocks.find((b) => anchorIdsOf(b).includes(anchorId));
  const block = holder && q.apply ? withAnchorText(holder, anchorId, q.apply) : null;
  return block ? ({ op: "set", block } as ProductBlockOp) : null;
}

/**
 * Le domande APERTE a cui chi guarda può rispondere (Home «Decide», il
 * riquadro): radici di Claude senza risposta, non eliminate, nei
 * progetti dove ha `docs.edit` — il filtro nella WHERE. `pageId` restringe a
 * una pagina.
 */
export async function listOpenProductQuestions(db: Db, viewer: Viewer, pageId?: string): Promise<ProductOpenQuestion[]> {
  const editable = await projectIdsWithPermission(db, viewer, "docs.edit");
  const scope = inProjects(productPages.projectId, editable);
  const rows = await db
    .select({ comment: productComments, pageTitle: productPages.title, projectId: productPages.projectId, number: docPageCodes.number, projectCode: projects.code })
    .from(productComments)
    .innerJoin(productPages, eq(productPages.id, productComments.pageId))
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .innerJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    .where(
      and(
        sql`${productComments.question} IS NOT NULL`,
        // La risposta chiude la domanda (e la risolve nella stessa scrittura): conta lei.
        isNull(productComments.answer),
        isNull(productComments.deletedAt),
        isNull(productComments.replyToId),
        pageId ? eq(productComments.pageId, pageId) : undefined,
        scope,
      ),
    )
    .orderBy(asc(productComments.createdAt), asc(productComments.id))
    .limit(200);
  const out: ProductOpenQuestion[] = [];
  const byPage = new Map<string, typeof rows>();
  for (const r of rows) byPage.set(r.comment.pageId, [...(byPage.get(r.comment.pageId) ?? []), r]);
  for (const [id, group] of byPage) {
    const ctx = await pageCtx(db, viewer, id);
    if (!ctx) continue;
    const views = await questionViews(db, viewer, ctx, group.map((g) => g.comment));
    for (const g of group) {
      const question = views.get(g.comment.id);
      if (!question) continue;
      out.push({
        commentId: g.comment.id,
        pageId: g.comment.pageId,
        pageCode: `${g.projectCode}-D${g.number}`,
        pageTitle: g.pageTitle,
        projectId: g.projectId,
        projectCode: g.projectCode,
        anchorId: g.comment.anchorId,
        question,
        createdAt: g.comment.createdAt.toISOString(),
      });
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commentId.localeCompare(b.commentId));
}
