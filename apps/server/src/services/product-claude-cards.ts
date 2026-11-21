import { productClaudeMarks, productComments, productPageRevisions, productPages, users, type Db } from "@stubwise/db";
import { instancePermissionsOfUser } from "@stubwise/notifications";
import { anchorIdsOf, productBlockSchema, type ProductBlock, type ProductDocClaudeCard, type ProductQuestionView } from "@stubwise/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { personName } from "./people.js";
import { visiblePersonIds } from "./people-visibility.js";
import { productSourceViews } from "./product-claude.js";
import { productQuestionViewsOf } from "./product-questions.js";

/**
 * Area 11, F5, Task 5 — quello che dicono le card `product_doc.updated` e
 * `product_doc.question`, DERIVATO a lettura per chi le riceve (CLAUDE.md,
 * «I campi che un client legge su una card… si DERIVANO»): il jsonb porta
 * solo l'id della revisione o del commento-domanda. La fonte nella forma di
 * chi legge (N-2 = a), le frasi, «per conto di» e chi ha annullato (R-G5), il
 * primo segno ancora a vista; per una domanda motivo e risposta di ADESSO,
 * così anche una card vecchia dice com'è andata.
 *
 * `null` nella mappa = l'oggetto non c'è più (la revisione, o il
 * commento-domanda eliminato): la card è `objectGone`. Una card che qui non
 * c'è non è di questi due kind.
 */

const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

export async function productClaudeCardsFor(db: Db, viewerId: string, rows: readonly { id: string; kind: string; event: unknown }[]): Promise<Map<string, ProductDocClaudeCard | null>> {
  const out = new Map<string, ProductDocClaudeCard | null>();
  const updates = rows.flatMap((r) => {
    const id = (r.event as { revisionId?: unknown } | null)?.revisionId;
    return r.kind === "product_doc.updated" ? [{ card: r.id, revisionId: isId(id) ? id : null }] : [];
  });
  const questions = rows.flatMap((r) => {
    const id = (r.event as { questionId?: unknown } | null)?.questionId;
    return r.kind === "product_doc.question" ? [{ card: r.id, commentId: isId(id) ? id : null }] : [];
  });
  if (updates.length === 0 && questions.length === 0) return out;
  const viewer = { id: viewerId, instancePermissions: await instancePermissionsOfUser(db, viewerId) };

  // --- updated ---
  const revIds = [...new Set(updates.flatMap((u) => (u.revisionId ? [u.revisionId] : [])))];
  const revs = new Map(revIds.length > 0 ? (await db.select().from(productPageRevisions).where(and(inArray(productPageRevisions.id, revIds), eq(productPageRevisions.kind, "claude")))).map((r) => [r.id, r]) : []);
  const marks = revs.size > 0 ? await db.select().from(productClaudeMarks).where(inArray(productClaudeMarks.revisionId, [...revs.keys()])).orderBy(asc(productClaudeMarks.createdAt), asc(productClaudeMarks.id)) : [];
  const pageIds = [...new Set([...revs.values()].map((r) => r.pageId))];
  // Le ancore di adesso, nell'ordine della pagina.
  const anchorsOn = new Map(
    pageIds.length > 0 ? (await db.select({ id: productPages.id, blocks: productPages.blocks }).from(productPages).where(inArray(productPages.id, pageIds))).map((p) => [p.id, readBlocks(p.blocks).flatMap(anchorIdsOf)]) : [],
  );
  const sources = await productSourceViews(db, viewer, [...revs.values()].flatMap((r) => (r.sourceKind && r.sourceId ? [{ kind: r.sourceKind, id: r.sourceId }] : [])));
  const people = await visiblePersonIds(db, viewer);
  const named = [...new Set([...[...revs.values()].map((r) => r.onBehalfOf), ...marks.map((m) => m.decidedBy)].filter((id): id is string => id !== null))];
  const names = new Map(named.length > 0 ? (await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, named))).map((u) => [u.id, personName(u)]) : []);
  const nameOf = (id: string | null) => (id && (people === "all" || people.includes(id)) ? (names.get(id) ?? null) : null);
  for (const u of updates) {
    const rev = u.revisionId ? revs.get(u.revisionId) : undefined;
    if (!rev) {
      out.set(u.card, null);
      continue;
    }
    const own = marks.filter((m) => m.revisionId === rev.id);
    const undone = own.filter((m) => m.status === "undone").sort((a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0));
    const open = new Set(own.filter((m) => m.status === "open").map((m) => m.anchorId));
    out.set(u.card, {
      revisionId: rev.id,
      sources: rev.sourceKind && rev.sourceId ? [sources.get(`${rev.sourceKind}:${rev.sourceId}`)!] : [],
      changes: own.length,
      onBehalfOfName: nameOf(rev.onBehalfOf),
      undoneByName: own.length > 0 && undone.length === own.length ? nameOf(undone[undone.length - 1]!.decidedBy) : null,
      // Dove porta la card: al primo segno (nell'ordine della pagina) ancora aperto e a vista; senza, alla cronologia.
      markAnchorId: (anchorsOn.get(rev.pageId) ?? []).find((a) => open.has(a)) ?? null,
      waited: null,
      question: null,
    });
  }

  // --- question ---
  const commentIds = [...new Set(questions.flatMap((q) => (q.commentId ? [q.commentId] : [])))];
  const comments = commentIds.length > 0 ? await db.select().from(productComments).where(and(inArray(productComments.id, commentIds), isNull(productComments.deletedAt))) : [];
  const byPage = new Map<string, typeof comments>();
  for (const c of comments) byPage.set(c.pageId, [...(byPage.get(c.pageId) ?? []), c]);
  const views = new Map<string, ProductQuestionView>();
  for (const [pageId, group] of byPage) for (const [id, view] of await productQuestionViewsOf(db, viewer, pageId, group)) views.set(id, view);
  for (const q of questions) {
    const view = q.commentId ? views.get(q.commentId) : undefined;
    if (!view) {
      out.set(q.card, null);
      continue;
    }
    out.set(q.card, {
      revisionId: null,
      sources: [view.source],
      changes: 0,
      onBehalfOfName: null,
      undoneByName: null,
      markAnchorId: null,
      waited: null,
      question: {
        reason: view.reason,
        forName: view.forName,
        taskCode: view.taskCode,
        answer: view.answer?.option ?? null,
        answeredByName: view.answer?.byName ?? null,
        canRequest: view.request !== null,
      },
    });
  }
  return out;
}
