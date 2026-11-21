import {
  emailMessages,
  googleAccounts,
  meetingNotes,
  productClaudeMarks,
  productComments,
  productPageRevisions,
  productPages,
  projectDecisions,
  projects,
  releases,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import {
  applyBlockOps,
  productBlockSchema,
  productSearchText,
  type ProductBlock,
  type ProductBlockChange,
  type ProductBlockOp,
  type ProductMarkView,
  type ProductRevisionView,
  type ProductSourceView,
  type ProductUndoView,
} from "@stubwise/shared";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { personName } from "./people.js";
import { visiblePersonIds } from "./people-visibility.js";
import { ProductDocsError } from "./product-docs.js";
import { holdTouchedSections } from "./product-docs-ops.js";
import { notifyProductRevision } from "./product-live-notify.js";

/**
 * Area 11, F5, Task 4 — le letture e i gesti sulle modifiche di Claude dalle
 * fonti: la fonte vista, i segni, «Looks good», «Undo» e «Undo all», i campi di
 * Claude sulle revisioni, la riga «riprende quando…».
 *
 * - La fonte la vede chi guarda: un'email (o una riunione) la APRE solo chi ha
 *   la casella — mai un admin per il ruolo (N-2 = a, `mailbox_owner`); gli
 *   altri leggono solo «da un'email di <titolare> · <data>». I nomi solo se
 *   chi guarda vede la persona (R-G5).
 * - «Undo» rimette l'ancora com'era PRIMA della revisione di Claude, sotto il
 *   lock della pagina e con le prese delle sezioni (F4: 409 `section_busy`). È
 *   spento se dopo Claude qualcuno ha toccato l'ancora (`changed_after`, chi),
 *   se il segno è già annullato, o senza `docs.edit`. Un «Undo» è UNA
 *   revisione `undo` con `undo_of` la revisione di Claude.
 * - Tutto si DERIVA a lettura (l'invariante delle card): nessuno stato «può
 *   annullare» salvato.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type RevisionRow = typeof productPageRevisions.$inferSelect;
type MarkRow = typeof productClaudeMarks.$inferSelect;
type SourceKind = MarkRow["sourceKind"];

const notFound = () => new ProductDocsError(404, "not_found", "Not found");

export class ProductUndoBlockedError extends ProductDocsError {
  constructor(
    readonly reason: "changed_after" | "already_undone",
    readonly by: { id: string | null; name: string | null },
  ) {
    super(409, reason, reason === "changed_after" ? "Someone changed it after Claude" : "Already undone");
  }
}

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

/** I nomi delle persone che chi guarda vede (R-G5). */
async function namesFor(db: Db, viewer: Viewer, ids: readonly (string | null)[]): Promise<(id: string | null) => string | null> {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null))];
  if (wanted.length === 0) return () => null;
  const people = await visiblePersonIds(db, viewer);
  const rows = await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(inArray(users.id, wanted));
  const names = new Map(rows.map((u) => [u.id, personName(u)]));
  return (id) => (id && (people === "all" || people.includes(id)) ? (names.get(id) ?? null) : null);
}

const key = (kind: string, id: string) => `${kind}:${id}`;

/** Le fonti come le vede chi guarda, in una lettura per tipo. */
export async function productSourceViews(db: Db, viewer: Viewer, refs: readonly { kind: SourceKind; id: string }[]): Promise<Map<string, ProductSourceView>> {
  const out = new Map<string, ProductSourceView>();
  const ids = (k: SourceKind) => [...new Set(refs.filter((r) => r.kind === k).map((r) => r.id))];
  const owners: (string | null)[] = [];
  const raw: { kind: SourceKind; id: string; title: string | null; code: string | null; ownerId: string | null; at: Date | null; mailOwner: boolean; thread: { threadId: string; accountId: string } | null }[] = [];

  const emailIds = ids("email");
  if (emailIds.length > 0) {
    const rows = await db
      .select({ id: emailMessages.id, subject: emailMessages.subject, at: emailMessages.receivedAt, threadId: emailMessages.threadId, accountId: emailMessages.accountId, ownerId: googleAccounts.userId })
      .from(emailMessages)
      .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
      .where(inArray(emailMessages.id, emailIds));
    for (const r of rows) raw.push({ kind: "email", id: r.id, title: r.subject, code: null, ownerId: r.ownerId, at: r.at, mailOwner: true, thread: { threadId: r.threadId, accountId: r.accountId } });
  }
  const meetingIds = ids("meeting");
  if (meetingIds.length > 0) {
    const rows = await db
      .select({ id: meetingNotes.id, docTitle: meetingNotes.docTitle, eventTitle: meetingNotes.eventTitle, at: meetingNotes.eventStartsAt, threadId: emailMessages.threadId, accountId: emailMessages.accountId, ownerId: googleAccounts.userId })
      .from(meetingNotes)
      .innerJoin(emailMessages, eq(emailMessages.id, meetingNotes.sourceMessageId))
      .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
      .where(inArray(meetingNotes.id, meetingIds));
    for (const r of rows) raw.push({ kind: "meeting", id: r.id, title: r.docTitle ?? r.eventTitle, code: null, ownerId: r.ownerId, at: r.at, mailOwner: true, thread: { threadId: r.threadId, accountId: r.accountId } });
  }
  const decisionIds = ids("decision");
  if (decisionIds.length > 0) {
    const rows = await db.select({ id: projectDecisions.id, title: projectDecisions.title, at: projectDecisions.decidedAt, by: projectDecisions.decidedByUserId }).from(projectDecisions).where(inArray(projectDecisions.id, decisionIds));
    for (const r of rows) raw.push({ kind: "decision", id: r.id, title: r.title, code: null, ownerId: r.by, at: r.at, mailOwner: false, thread: null });
  }
  const taskIds = ids("task");
  const hiddenTasks = new Set<string>();
  if (taskIds.length > 0) {
    const rows = await db.select({ id: tickets.id, title: tickets.title, number: tickets.number, code: projects.code, at: tickets.updatedAt, projectId: tickets.projectId, requester: tickets.requestedByUserId }).from(tickets).innerJoin(projects, eq(projects.id, tickets.projectId)).where(inArray(tickets.id, taskIds));
    // La task la apre chi la VEDE (`canSeeTicket`: `tickets.view_all`, o chi l'ha chiesta); gli altri leggono solo il codice.
    const permsOf = new Map<string, ReadonlySet<string> | null>();
    for (const r of rows) {
      if (!permsOf.has(r.projectId)) permsOf.set(r.projectId, await projectPermissionsFor(db, viewer, r.projectId));
      const perms = permsOf.get(r.projectId);
      if (!perms || !(perms.has("tickets.view_all") || r.requester === viewer.id)) hiddenTasks.add(r.id);
      raw.push({ kind: "task", id: r.id, title: r.title, code: `${r.code}-${r.number}`, ownerId: null, at: r.at, mailOwner: false, thread: null });
    }
  }
  const releaseIds = ids("release");
  if (releaseIds.length > 0) {
    const rows = await db.select({ id: releases.id, title: releases.title, code: releases.code, at: releases.mergedAt }).from(releases).where(inArray(releases.id, releaseIds));
    for (const r of rows) raw.push({ kind: "release", id: r.id, title: r.title, code: r.code, ownerId: null, at: r.at, mailOwner: false, thread: null });
  }
  for (const r of raw) owners.push(r.ownerId);
  const nameOf = await namesFor(db, viewer, owners);
  for (const r of raw) {
    // N-2 = a: la posta la apre SOLO chi ha la casella, mai un admin per il ruolo.
    const canOpen = r.mailOwner ? r.ownerId === viewer.id : !(r.kind === "task" && hiddenTasks.has(r.id));
    out.set(key(r.kind, r.id), {
      kind: r.kind,
      canOpen,
      id: canOpen ? r.id : null,
      title: canOpen ? r.title : null,
      code: r.code,
      ownerId: r.ownerId,
      ownerName: nameOf(r.ownerId),
      at: r.at?.toISOString() ?? null,
      gone: false,
      thread: canOpen ? r.thread : null,
    });
  }
  for (const r of refs) {
    if (!out.has(key(r.kind, r.id))) out.set(key(r.kind, r.id), { kind: r.kind, canOpen: false, id: null, title: null, code: null, ownerId: null, ownerName: null, at: null, gone: true, thread: null });
  }
  return out;
}

const touches = (r: Pick<RevisionRow, "changes">, anchorId: string) => (r.changes as ProductBlockChange[]).some((c) => c.anchors.includes(anchorId) || c.blockId === anchorId);

/** La modifica di una revisione su un'ancora. */
const changeOf = (rev: Pick<RevisionRow, "changes">, anchorId: string) => (rev.changes as ProductBlockChange[]).find((c) => c.anchors.includes(anchorId) || c.blockId === anchorId) ?? null;

/**
 * Lo stato di «Undo» di un segno, derivato: annullato, toccato dopo da
 * qualcuno (non dal suo stesso Undo), o senza permesso.
 */
function undoStateOf(mark: Pick<MarkRow, "status" | "decidedBy" | "anchorId">, rev: Pick<RevisionRow, "id" | "lastSeq" | "changes">, later: readonly RevisionRow[], canEdit: boolean): { reason: ProductUndoView["reason"]; byId: string | null } {
  // Come il prototipo (`anchorUndo`, review di R11-5, B): il permesso prima di tutto.
  if (!canEdit) return { reason: "no_permission", byId: null };
  // Un segno accettato («Looks good») si annulla lo stesso (review di R11-5, A); uno annullato no.
  if (mark.status === "undone") return { reason: "already_undone", byId: mark.decidedBy };
  const touchedAfter = (anchorId: string) => later.filter((r) => r.lastSeq > rev.lastSeq && touches(r, anchorId));
  const own = touchedAfter(mark.anchorId);
  if (own.length > 0) return { reason: "changed_after", byId: own[own.length - 1]!.actorId };
  // Un blocco AGGIUNTO da Claude si annulla togliendolo tutto: una cella toccata da una persona spegne ogni cella.
  const change = changeOf(rev, mark.anchorId);
  if (change && change.before === null) {
    for (const other of change.anchors) {
      const after = touchedAfter(other);
      if (after.length > 0) return { reason: "changed_after", byId: after[0]!.actorId };
    }
  }
  return { reason: null, byId: null };
}

const undoView = (state: { reason: ProductUndoView["reason"]; byId: string | null }, nameOf: (id: string | null) => string | null): ProductUndoView =>
  state.reason === null ? { enabled: true, reason: null, byId: null, byName: null } : { enabled: false, reason: state.reason, byId: state.reason === "no_permission" ? null : state.byId, byName: state.reason === "no_permission" ? null : nameOf(state.byId) };

/** Dove sta un'ancora: il blocco, e per una cella la riga e la colonna (1 = la prima). */
function locate(blocks: readonly ProductBlock[], anchorId: string): { blockId: string; cell: { row: number; col: number } | null } | null {
  for (const b of blocks) {
    if (b.id === anchorId) return { blockId: b.id, cell: null };
    if (b.type === "table") {
      for (const [ri, row] of b.rows.entries()) {
        const ci = row.cells.findIndex((c) => c.id === anchorId);
        if (ci >= 0) return { blockId: b.id, cell: { row: ri + 1, col: ci + 1 } };
      }
    }
  }
  return null;
}

async function pageAndPerms(db: Db, viewer: Viewer, pageId: string) {
  const [page] = await db.select().from(productPages).where(eq(productPages.id, pageId));
  if (!page) throw notFound();
  const perms = await projectPermissionsFor(db, viewer, page.projectId);
  if (!perms?.has("docs.view")) throw notFound();
  return { page, canEdit: perms.has("docs.edit") };
}

/** I segni APERTI di una pagina, come li legge chi guarda. */
export async function listProductMarks(db: Db, viewer: Viewer, pageId: string): Promise<ProductMarkView[]> {
  const { page, canEdit } = await pageAndPerms(db, viewer, pageId);
  const marks = await db.select().from(productClaudeMarks).where(eq(productClaudeMarks.pageId, pageId)).orderBy(asc(productClaudeMarks.createdAt));
  const open = marks.filter((m) => m.status === "open");
  if (open.length === 0) return [];
  const revIds = [...new Set(open.map((m) => m.revisionId))];
  const revs = new Map((await db.select().from(productPageRevisions).where(inArray(productPageRevisions.id, revIds))).map((r) => [r.id, r]));
  const minSeq = Math.min(...[...revs.values()].map((r) => r.lastSeq));
  const later = await db.select().from(productPageRevisions).where(and(eq(productPageRevisions.pageId, pageId), gt(productPageRevisions.lastSeq, minSeq))).orderBy(asc(productPageRevisions.lastSeq));
  const blocks = readBlocks(page.blocks);
  const states = open.map((m) => undoStateOf(m, revs.get(m.revisionId)!, later, canEdit));
  const nameOf = await namesFor(db, viewer, [...[...revs.values()].map((r) => r.onBehalfOf), ...states.map((s) => s.byId)]);
  const sources = await productSourceViews(db, viewer, open.map((m) => ({ kind: m.sourceKind, id: m.sourceId })));
  const groupSize = new Map<string, number>();
  for (const m of marks) groupSize.set(m.revisionId, (groupSize.get(m.revisionId) ?? 0) + 1);
  return open.flatMap((m, i) => {
    const rev = revs.get(m.revisionId)!;
    const at = locate(blocks, m.anchorId);
    if (!at) return [];
    return [
      {
        id: m.id,
        anchorId: m.anchorId,
        blockId: at.blockId,
        cell: at.cell,
        revisionId: m.revisionId,
        groupAnchors: groupSize.get(m.revisionId) ?? 1,
        actorId: rev.actorId,
        onBehalfOfId: rev.onBehalfOf,
        onBehalfOfName: nameOf(rev.onBehalfOf),
        at: rev.createdAt.toISOString(),
        source: sources.get(key(m.sourceKind, m.sourceId))!,
        canAccept: canEdit,
        undo: undoView(states[i]!, nameOf),
      },
    ];
  });
}

/** Il segno e la sua pagina, o 404 (anche per chi non vede la pagina). */
async function markAndPage(db: Db, viewer: Viewer, markId: string) {
  const [mark] = await db.select().from(productClaudeMarks).where(eq(productClaudeMarks.id, markId));
  if (!mark) throw notFound();
  const { page, canEdit } = await pageAndPerms(db, viewer, mark.pageId);
  if (!canEdit) throw new ProductDocsError(403, "forbidden", "Forbidden");
  return { mark, page };
}

/** «Looks good»: il segno si toglie. Idempotente su un segno già accettato; 409 su uno annullato. */
export async function acceptProductMark(db: Db, viewer: Viewer, markId: string): Promise<void> {
  const { mark } = await markAndPage(db, viewer, markId);
  if (mark.status === "undone") throw new ProductUndoBlockedError("already_undone", { id: mark.decidedBy, name: null });
  await db.update(productClaudeMarks).set({ status: "looks_good", decidedBy: viewer.id, decidedAt: new Date() }).where(and(eq(productClaudeMarks.id, markId), eq(productClaudeMarks.status, "open")));
}

/** Rimette `anchorId` com'era prima di `change`, sui blocchi di adesso. */
function restoreOp(blocks: readonly ProductBlock[], change: ProductBlockChange, anchorId: string): ProductBlockOp | null {
  const current = blocks.find((b) => b.id === change.blockId);
  if (change.before === null) return current ? { op: "delete", blockId: change.blockId } : null;
  if (!current) return null;
  if (current.type === "table" && anchorId !== current.id && change.before.type === "table") {
    const old = change.before.rows.flatMap((r) => r.cells).find((c) => c.id === anchorId);
    if (!old) return null;
    return { op: "set", block: { ...current, rows: current.rows.map((r) => ({ ...r, cells: r.cells.map((c) => (c.id === anchorId ? { ...c, content: old.content } : c)) })) } } as ProductBlockOp;
  }
  return { op: "set", block: change.before } as ProductBlockOp;
}

export interface ProductUndoResult {
  seq: number;
  /** Null se non c'era più niente da rimettere (il segno si chiude lo stesso). */
  revisionId: string | null;
}

/**
 * «Undo» di uno o più segni della STESSA revisione di Claude («Undo all» =
 * tutti i suoi segni aperti). Tutto o niente: un segno toccato dopo blocca
 * il gesto (409 `changed_after`), uno già annullato non conta (tutti annullati:
 * 409 `already_undone`).
 */
async function undoMarks(db: Db, viewer: Viewer, pageId: string, revisionId: string, only: string | null): Promise<ProductUndoResult> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [page] = await tx.select().from(productPages).where(eq(productPages.id, pageId)).for("no key update");
    if (!page) throw notFound();
    const [rev] = await tx.select().from(productPageRevisions).where(and(eq(productPageRevisions.id, revisionId), eq(productPageRevisions.pageId, pageId)));
    if (!rev || rev.kind !== "claude") throw notFound();
    const all = await tx.select().from(productClaudeMarks).where(eq(productClaudeMarks.revisionId, revisionId)).for("update");
    const targets = all.filter((m) => (only === null || m.id === only));
    // Anche i segni accettati: «Looks good» non toglie «Undo» (review di R11-5, A).
    const live = targets.filter((m) => m.status !== "undone");
    // Un blocco aggiunto da Claude se ne va tutto: con lui i segni di tutte le sue celle.
    const siblings = new Set(live.flatMap((m) => {
      const change = changeOf(rev, m.anchorId);
      return change && change.before === null ? change.anchors : [];
    }));
    const open = all.filter((m) => m.status !== "undone" && (live.includes(m) || siblings.has(m.anchorId)));
    const later = await tx.select().from(productPageRevisions).where(and(eq(productPageRevisions.pageId, pageId), gt(productPageRevisions.lastSeq, rev.lastSeq))).orderBy(asc(productPageRevisions.lastSeq));
    if (live.length === 0) {
      const undone = targets.find((m) => m.status === "undone");
      throw new ProductUndoBlockedError("already_undone", { id: undone?.decidedBy ?? null, name: (await namesFor(tx, viewer, [undone?.decidedBy ?? null]))(undone?.decidedBy ?? null) });
    }
    for (const m of open) {
      const state = undoStateOf(m, rev, later, true);
      if (state.reason === "changed_after") throw new ProductUndoBlockedError("changed_after", { id: state.byId, name: (await namesFor(tx, viewer, [state.byId]))(state.byId) });
    }
    let blocks = readBlocks(page.blocks);
    const ops: ProductBlockOp[] = [];
    for (const m of open) {
      const change = changeOf(rev, m.anchorId);
      const op = change ? restoreOp(blocks, change, m.anchorId) : null;
      if (!op) continue;
      ops.push(op);
      // Le operazioni successive leggono i blocchi già rimessi (due celle della stessa tabella).
      blocks = applyBlockOps(blocks, [op]).blocks;
    }
    // F4: le sezioni toccate si prendono (409 se le ha un altro), sui blocchi di PRIMA.
    const before = readBlocks(page.blocks);
    await holdTouchedSections(tx, viewer, pageId, before, ops);
    const next = applyBlockOps(before, ops);
    const close = () =>
      tx
        .update(productClaudeMarks)
        .set({ status: "undone", decidedBy: viewer.id, decidedAt: new Date() })
        .where(inArray(productClaudeMarks.id, open.map((m) => m.id)));
    if (next.changes.length === 0) {
      await close();
      return { seq: page.revSeq, revisionId: null };
    }
    const [{ seq }] = (await tx
      .update(productPages)
      .set({ blocks: next.blocks, searchText: productSearchText(page.title, next.blocks), revSeq: sql`${productPages.revSeq} + 1`, updatedBy: viewer.id, updatedAt: new Date() })
      .where(eq(productPages.id, pageId))
      .returning({ seq: productPages.revSeq })) as [{ seq: number }];
    const [undo] = await tx
      .insert(productPageRevisions)
      .values({ pageId, sessionId: null, seq, lastSeq: seq, actorId: viewer.id, kind: "undo", undoOf: rev.id, changes: next.changes as unknown[] })
      .returning({ id: productPageRevisions.id });
    await close();
    await notifyProductRevision(tx, { pageId, seq, kind: "undo", actorId: viewer.id, sessionId: null });
    return { seq, revisionId: undo!.id };
  });
}

export async function undoProductMark(db: Db, viewer: Viewer, markId: string): Promise<ProductUndoResult> {
  const { mark } = await markAndPage(db, viewer, markId);
  return undoMarks(db, viewer, mark.pageId, mark.revisionId, mark.id);
}

export async function undoProductRevision(db: Db, viewer: Viewer, revisionId: string): Promise<ProductUndoResult> {
  const [rev] = await db.select({ pageId: productPageRevisions.pageId }).from(productPageRevisions).where(eq(productPageRevisions.id, revisionId));
  if (!rev) throw notFound();
  const { canEdit } = await pageAndPerms(db, viewer, rev.pageId);
  if (!canEdit) throw new ProductDocsError(403, "forbidden", "Forbidden");
  return undoMarks(db, viewer, rev.pageId, revisionId, null);
}

/**
 * I campi di Claude sulle revisioni lette (additivi): la fonte vista, per
 * conto di chi, «Undo all» e lo stato di «Undo» per ancora.
 */
export async function withClaudeFields(db: Db, viewer: Viewer, pageId: string, input: ProductRevisionView[]): Promise<ProductRevisionView[]> {
  // «Update it» su una domanda di Claude: la revisione `edit` porta il commento della domanda (DERIVATO dalla risposta).
  const editIds = input.filter((v) => v.kind === "edit").map((v) => v.id);
  const answered =
    editIds.length > 0
      ? await db
          .select({ id: productComments.id, revisionId: sql<string>`${productComments.answer}->>'revisionId'` })
          .from(productComments)
          .where(and(eq(productComments.pageId, pageId), inArray(sql`${productComments.answer}->>'revisionId'`, editIds)))
      : [];
  const answerOf = new Map(answered.map((a) => [a.revisionId, a.id]));
  const views = answerOf.size > 0 ? input.map((v) => (answerOf.has(v.id) ? { ...v, answerOf: answerOf.get(v.id)! } : v)) : input;
  const claudeIds = views.filter((v) => v.kind === "claude" || v.kind === "undo").map((v) => v.id);
  if (claudeIds.length === 0) return views;
  const rows = new Map((await db.select().from(productPageRevisions).where(inArray(productPageRevisions.id, claudeIds))).map((r) => [r.id, r]));
  const claudeRevs = [...rows.values()].filter((r) => r.kind === "claude");
  const marks = claudeRevs.length > 0 ? await db.select().from(productClaudeMarks).where(inArray(productClaudeMarks.revisionId, claudeRevs.map((r) => r.id))) : [];
  const minSeq = claudeRevs.length > 0 ? Math.min(...claudeRevs.map((r) => r.lastSeq)) : 0;
  const later = claudeRevs.length > 0 ? await db.select().from(productPageRevisions).where(and(eq(productPageRevisions.pageId, pageId), gt(productPageRevisions.lastSeq, minSeq))).orderBy(asc(productPageRevisions.lastSeq)) : [];
  const [page] = await db.select({ projectId: productPages.projectId }).from(productPages).where(eq(productPages.id, pageId));
  const canEdit = page ? (await projectPermissionsFor(db, viewer, page.projectId))?.has("docs.edit") === true : false;
  const sources = await productSourceViews(
    db,
    viewer,
    claudeRevs.flatMap((r) => (r.sourceKind && r.sourceId ? [{ kind: r.sourceKind, id: r.sourceId }] : [])),
  );
  const perRev = new Map<string, { byAnchor: Record<string, { reason: ProductUndoView["reason"]; byId: string | null }>; markIds: Record<string, string>; done: number; count: number; undoneBy: string | null }>();
  for (const r of claudeRevs) {
    const own = marks.filter((m) => m.revisionId === r.id);
    const byAnchor: Record<string, { reason: ProductUndoView["reason"]; byId: string | null }> = {};
    for (const m of own) byAnchor[m.anchorId] = undoStateOf(m, r, later, canEdit);
    const undone = own.filter((m) => m.status === "undone");
    perRev.set(r.id, { byAnchor, markIds: Object.fromEntries(own.map((m) => [m.anchorId, m.id])), done: undone.length, count: own.length, undoneBy: undone[undone.length - 1]?.decidedBy ?? null });
  }
  const nameOf = await namesFor(db, viewer, [...claudeRevs.map((r) => r.onBehalfOf), ...[...perRev.values()].flatMap((p) => [p.undoneBy, ...Object.values(p.byAnchor).map((s) => s.byId)])]);
  return views.map((v) => {
    const r = rows.get(v.id);
    if (!r) return v;
    if (r.kind === "undo") return { ...v, undoOf: r.undoOf };
    const p = perRev.get(r.id)!;
    const states = Object.values(p.byAnchor);
    // «Undo all»: acceso se c'è almeno un segno aperto e nessuno toccato dopo.
    const all =
      states.length === 0 || states.every((s) => s.reason === "already_undone")
        ? { reason: "already_undone" as const, byId: p.undoneBy }
        : (states.find((s) => s.reason === "changed_after") ?? states.find((s) => s.reason === "no_permission") ?? { reason: null, byId: null });
    return {
      ...v,
      via: r.via,
      onBehalfOfId: r.onBehalfOf,
      onBehalfOfName: nameOf(r.onBehalfOf),
      source: r.sourceKind && r.sourceId ? (sources.get(key(r.sourceKind, r.sourceId)) ?? null) : null,
      undo: undoView(all, nameOf),
      undoByAnchor: Object.fromEntries(Object.entries(p.byAnchor).map(([a, s]) => [a, undoView(s, nameOf)])),
      // L'id del segno per ancora (review di R11-5): «Undo» dalla cronologia anche di un segno accettato.
      markIdByAnchor: p.markIds,
      undoneCount: { done: p.done, count: p.count },
      undoneById: p.undoneBy,
      undoneByName: nameOf(p.undoneBy),
    };
  });
}
