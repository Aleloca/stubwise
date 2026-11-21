import {
  driveFiles,
  emailMessages,
  emailProposals,
  googleAccounts,
  meetingNotes,
  productComments,
  productDocJobs,
  productFirstVersions,
  productPageRevisions,
  productPages,
  projects,
  users,
  type Db,
} from "@stubwise/db";
import { aiBudgetState } from "@stubwise/notifications";
import type { FirstVersionSource, ProductFirstVersionSources, ProductFirstVersionUndo, ProductFirstVersionView, ProductSourceView } from "@stubwise/shared";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { personName } from "./people.js";
import { visiblePersonIds } from "./people-visibility.js";
import { productSourceViews } from "./product-claude.js";
import { ProductDocsError, deleteProductPage } from "./product-docs.js";

/**
 * Area 11, F6 — la prima versione di Claude in uno spazio Product vuoto: le
 * fonti, l'avvio, la lettura, «Undo the first version», «Stop», «Accept this
 * page». La regola del prototipo (`data/productDocs/firstVersion.ts`):
 * - la chiede chi ha `docs.edit`, scegliendo fra le fonti del progetto che
 *   VEDE: un'email o una riunione della SUA casella (mai un admin per il
 *   ruolo, N-2 = a), un file del Drive visibile e non nascosto, il testo
 *   incollato. Una fonte che non vede è 422 `invalid_source`, come una che non
 *   c'è;
 * - lo spazio dev'essere vuoto e senza un'altra prima versione che scrive (409
 *   `space_not_empty`); col budget del mese finito non parte (409
 *   `ai_blocked`); la pausa della coda non la ferma;
 * - le pagine le scrive il worker, una alla volta (`writeFirstVersionPage`);
 *   «Stop» si onora prima della pagina dopo;
 * - «Undo» toglie tutte le sue pagine (dalle foglie alla radice) finché
 *   nessuno le ha toccate: una revisione dopo quella di Claude, un commento,
 *   una risposta di una persona a una domanda di Claude, una pagina nuova nello
 *   spazio. Dopo è 409 `changed_after` col primo che ha toccato, la pagina e
 *   come;
 * - le fonti si leggono nella forma di chi guarda (N-2 = a): mai l'oggetto di
 *   un'email di un altro.
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type FvRow = typeof productFirstVersions.$inferSelect;
type SourceRef = { kind: "email"; id: string } | { kind: "meeting"; id: string } | { kind: "drive"; fileId: string } | { kind: "text" };

const notFound = () => new ProductDocsError(404, "not_found", "Not found");

/** 409 «Undo» spento: toccata dopo Claude (chi, dove, come), o già annullata. */
export class FirstVersionUndoBlockedError extends ProductDocsError {
  constructor(readonly undo: ProductFirstVersionUndo) {
    super(409, undo.reason ?? "changed_after", undo.reason === "already_undone" ? "Already undone" : "Someone changed the first version");
  }
}

async function permsOf(db: Db, viewer: Viewer, projectId: string): Promise<ReadonlySet<string>> {
  const perms = await projectPermissionsFor(db, viewer, projectId);
  if (!perms) throw notFound();
  return perms;
}

/** Le email del progetto della casella di chi guarda: ammesse, con una proposta per il progetto non scartata. */
async function ownEmails(db: Db, viewer: Viewer, projectId: string) {
  return db
    .selectDistinct({ id: emailMessages.id, fromName: emailMessages.fromName, fromAddress: emailMessages.fromAddress, subject: emailMessages.subject, at: emailMessages.receivedAt })
    .from(emailMessages)
    .innerJoin(googleAccounts, and(eq(googleAccounts.id, emailMessages.accountId), eq(googleAccounts.userId, viewer.id)))
    .innerJoin(emailProposals, and(eq(emailProposals.emailMessageId, emailMessages.id), eq(emailProposals.projectId, projectId), ne(emailProposals.status, "ignored")))
    .where(and(eq(emailMessages.admitted, true), sql`not exists (select 1 from meeting_notes mn where mn.source_message_id = ${emailMessages.id})`))
    .orderBy(desc(emailMessages.receivedAt));
}

/** Le riunioni del progetto della casella di chi guarda (l'id è il messaggio della riunione). */
async function ownMeetings(db: Db, viewer: Viewer, projectId: string) {
  return db
    .select({ id: meetingNotes.sourceMessageId, title: meetingNotes.docTitle, event: meetingNotes.eventTitle, at: meetingNotes.eventStartsAt, received: emailMessages.receivedAt, status: meetingNotes.docStatus })
    .from(meetingNotes)
    .innerJoin(emailMessages, eq(emailMessages.id, meetingNotes.sourceMessageId))
    .innerJoin(googleAccounts, and(eq(googleAccounts.id, emailMessages.accountId), eq(googleAccounts.userId, viewer.id)))
    .where(eq(meetingNotes.projectId, projectId))
    .orderBy(desc(emailMessages.receivedAt));
}

/** I file del Drive del progetto che si vedono: non eliminati, non nascosti, raggiungibili. */
async function visibleFiles(db: Db, projectId: string) {
  return db
    .select({ id: driveFiles.id, number: driveFiles.number, name: driveFiles.name, type: driveFiles.type, code: projects.code })
    .from(driveFiles)
    .innerJoin(projects, eq(projects.id, driveFiles.projectId))
    .where(and(eq(driveFiles.projectId, projectId), isNull(driveFiles.deletedAt), eq(driveFiles.hidden, false), isNull(driveFiles.unavailable)))
    .orderBy(asc(driveFiles.number));
}

/** Le fonti fra cui chi guarda sceglie: vuote per chi non legge i Docs del progetto. */
export async function firstVersionSources(db: Db, viewer: Viewer, projectId: string): Promise<ProductFirstVersionSources> {
  const perms = await permsOf(db, viewer, projectId);
  if (!perms.has("docs.view")) return { emails: [], meetings: [], files: [] };
  const [emails, meetings, files] = await Promise.all([ownEmails(db, viewer, projectId), ownMeetings(db, viewer, projectId), visibleFiles(db, projectId)]);
  return {
    emails: emails.map((e) => ({ id: e.id, fromName: e.fromName ?? e.fromAddress, subject: e.subject ?? "", at: e.at.toISOString() })),
    meetings: meetings.map((m) => ({ id: m.id, title: m.title ?? m.event ?? "", at: (m.at ?? m.received).toISOString(), transcript: m.status === "ready" })),
    files: files.map((f) => ({ id: f.id, code: `${f.code}-F${f.number}`, name: f.name, type: f.type })),
  };
}

/**
 * «Write the first version»: rilegge le fonti con la visibilità di chi chiede,
 * e accoda il lavoro. Lo stato è intatto dopo un rifiuto.
 */
export async function startFirstVersion(db: Db, viewer: Viewer, projectId: string, sources: readonly FirstVersionSource[], budget: { monthlyCostUsdFn?: (db: Db) => Promise<number> } = {}): Promise<{ groupId: string }> {
  const perms = await permsOf(db, viewer, projectId);
  if (!perms.has("docs.view")) throw notFound();
  if (!perms.has("docs.edit")) throw new ProductDocsError(403, "forbidden", "Forbidden");
  const [emails, meetings, files] = await Promise.all([ownEmails(db, viewer, projectId), ownMeetings(db, viewer, projectId), visibleFiles(db, projectId)]);
  const refs = new Map<string, SourceRef>();
  let pasted: string | null = null;
  for (const s of sources) {
    if (s.kind === "text") {
      if (s.text.trim() === "") continue;
      pasted = pasted === null ? s.text : `${pasted}\n\n${s.text}`;
      refs.set("text", { kind: "text" });
      continue;
    }
    const ok = s.kind === "email" ? emails.some((e) => e.id === s.id) : s.kind === "meeting" ? meetings.some((m) => m.id === s.id) : files.some((f) => f.id === s.fileId);
    // Una fonte che chi chiede non vede non esiste per lui (R-G5): come una che non c'è.
    if (!ok) throw new ProductDocsError(422, "invalid_source", "A source is not one you can see");
    refs.set(s.kind === "drive" ? `drive:${s.fileId}` : `${s.kind}:${s.id}`, s.kind === "drive" ? { kind: "drive", fileId: s.fileId } : { kind: s.kind, id: s.id });
  }
  if (refs.size === 0) throw new ProductDocsError(422, "no_sources", "Choose at least one source");
  if ((await aiBudgetState(db, budget.monthlyCostUsdFn)).exhausted) throw new ProductDocsError(409, "ai_blocked", "The monthly AI budget is used up");
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stubwise-product-tree:${projectId}`}))`);
    const [page] = await tx.select({ id: productPages.id }).from(productPages).where(eq(productPages.projectId, projectId)).limit(1);
    const [writing] = await tx.select({ id: productFirstVersions.id }).from(productFirstVersions).where(and(eq(productFirstVersions.projectId, projectId), eq(productFirstVersions.status, "writing"))).limit(1);
    if (page || writing) throw new ProductDocsError(409, "space_not_empty", "The space already has pages, or a first version is being written");
    const [fv] = await tx.insert(productFirstVersions).values({ projectId, startedBy: viewer.id, sources: [...refs.values()], pastedText: pasted }).returning({ id: productFirstVersions.id });
    await tx.insert(productDocJobs).values({ projectId, sourceKind: "first_version", sourceId: fv!.id });
    return { groupId: fv!.id };
  });
}

/** L'ultima prima versione dello spazio. */
async function latestOf(db: Db, projectId: string): Promise<FvRow | null> {
  const [row] = await db.select().from(productFirstVersions).where(eq(productFirstVersions.projectId, projectId)).orderBy(desc(productFirstVersions.createdAt)).limit(1);
  return row ?? null;
}

interface Touch {
  at: Date;
  byId: string | null;
  pageId: string | null;
  touch: "edit" | "comment" | "answer" | "page";
}

/** Il primo tocco dopo la prima versione: una revisione dopo quella di Claude, un commento, una risposta, una pagina nuova. */
async function firstTouch(db: Db, fv: FvRow): Promise<Touch | null> {
  const pageIds = fv.written.map((w) => w.pageId);
  const own = new Set(fv.written.map((w) => w.revisionId));
  const touches: Touch[] = [];
  if (pageIds.length > 0) {
    const revs = await db.select({ id: productPageRevisions.id, pageId: productPageRevisions.pageId, actorId: productPageRevisions.actorId, at: productPageRevisions.createdAt }).from(productPageRevisions).where(inArray(productPageRevisions.pageId, pageIds));
    for (const r of revs) if (!own.has(r.id)) touches.push({ at: r.at, byId: r.actorId, pageId: r.pageId, touch: "edit" });
    const comments = await db
      .select({ pageId: productComments.pageId, authorId: productComments.authorId, at: productComments.createdAt, answer: productComments.answer, agent: users.isAgent })
      .from(productComments)
      .leftJoin(users, eq(users.id, productComments.authorId))
      .where(inArray(productComments.pageId, pageIds));
    for (const c of comments) {
      if (c.agent !== true) touches.push({ at: c.at, byId: c.authorId, pageId: c.pageId, touch: "comment" });
      const answer = c.answer as { byId?: string; at?: string } | null;
      if (answer?.byId) touches.push({ at: answer.at ? new Date(answer.at) : c.at, byId: answer.byId, pageId: c.pageId, touch: "answer" });
    }
  }
  const others = await db
    .select({ id: productPages.id, createdBy: productPages.createdBy, at: productPages.createdAt })
    .from(productPages)
    .where(and(eq(productPages.projectId, fv.projectId), gt(productPages.createdAt, fv.createdAt)));
  for (const p of others) if (!pageIds.includes(p.id)) touches.push({ at: p.at, byId: p.createdBy, pageId: p.id, touch: "page" });
  return touches.sort((a, b) => a.at.getTime() - b.at.getTime())[0] ?? null;
}

async function namesFor(db: Db, viewer: Viewer, ids: readonly (string | null)[]): Promise<(id: string | null) => string | null> {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null))];
  if (wanted.length === 0) return () => null;
  const people = await visiblePersonIds(db, viewer);
  const rows = await db.select({ id: users.id, email: users.email, displayName: users.displayName, agent: users.isAgent }).from(users).where(inArray(users.id, wanted));
  const names = new Map(rows.map((u) => [u.id, { name: personName(u), agent: u.agent }]));
  return (id) => {
    const u = id ? names.get(id) : undefined;
    return u && (u.agent || people === "all" || people.includes(id!)) ? u.name : null;
  };
}

async function undoOf(db: Db, viewer: Viewer, fv: FvRow, canEdit: boolean): Promise<ProductFirstVersionUndo> {
  const off = (reason: "no_permission" | "already_undone" | "changed_after", byId: string | null, extra: Partial<ProductFirstVersionUndo> = {}): ProductFirstVersionUndo => ({ enabled: false, reason, byId, byName: null, pageId: null, pageTitle: null, touch: null, ...extra });
  if (!canEdit) return off("no_permission", null);
  const nameOf = await namesFor(db, viewer, [fv.undoneBy]);
  if (fv.status === "undone") return { ...off("already_undone", nameOf(fv.undoneBy) ? fv.undoneBy : null), byName: nameOf(fv.undoneBy) };
  const touch = await firstTouch(db, fv);
  if (!touch) return { enabled: true, reason: null, byId: null, byName: null, pageId: null, pageTitle: null, touch: null };
  const touchName = (await namesFor(db, viewer, [touch.byId]))(touch.byId);
  const [page] = touch.pageId ? await db.select({ id: productPages.id, title: productPages.title }).from(productPages).where(eq(productPages.id, touch.pageId)) : [];
  return off("changed_after", touchName ? touch.byId : null, { byName: touchName, pageId: page?.id ?? null, pageTitle: page?.title ?? null, touch: touch.touch });
}

/** Le fonti di una prima versione come le legge chi guarda. */
async function sourceViewsOf(db: Db, viewer: Viewer, fv: FvRow): Promise<ProductSourceView[]> {
  const refs = fv.sources as SourceRef[];
  const mail = await productSourceViews(
    db,
    viewer,
    refs.flatMap((r) => (r.kind === "email" ? [{ kind: "email" as const, id: r.id }] : [])),
  );
  // Una riunione si guarda come l'email di Gemini da cui nasce: il titolare, e il titolo solo per lui.
  const meetingIds = refs.flatMap((r) => (r.kind === "meeting" ? [r.id] : []));
  const meetings = new Map(
    meetingIds.length > 0
      ? (await db.select({ id: meetingNotes.sourceMessageId, noteId: meetingNotes.id }).from(meetingNotes).where(inArray(meetingNotes.sourceMessageId, meetingIds))).map((m) => [m.id, m.noteId])
      : [],
  );
  const meetingViews = await productSourceViews(db, viewer, [...meetings.values()].map((id) => ({ kind: "meeting" as const, id })));
  const fileIds = refs.flatMap((r) => (r.kind === "drive" ? [r.fileId] : []));
  const files = new Map(
    fileIds.length > 0
      ? (await db.select({ id: driveFiles.id, name: driveFiles.name, number: driveFiles.number, code: projects.code, deletedAt: driveFiles.deletedAt, hidden: driveFiles.hidden, unavailable: driveFiles.unavailable, at: driveFiles.addedAt }).from(driveFiles).innerJoin(projects, eq(projects.id, driveFiles.projectId)).where(inArray(driveFiles.id, fileIds))).map((f) => [f.id, f])
      : [],
  );
  const empty = { canOpen: false, id: null, title: null, code: null, ownerId: null, ownerName: null, at: null, gone: false, thread: null };
  return refs.map((r): ProductSourceView => {
    if (r.kind === "text") return { kind: "text", ...empty };
    if (r.kind === "email") return mail.get(`email:${r.id}`) ?? { kind: "email", ...empty, gone: true };
    if (r.kind === "meeting") {
      const noteId = meetings.get(r.id);
      return (noteId ? meetingViews.get(`meeting:${noteId}`) : undefined) ?? { kind: "meeting", ...empty, gone: true };
    }
    const f = files.get(r.fileId);
    if (!f || f.deletedAt) return { kind: "drive", ...empty, gone: true };
    // Un file nascosto (o irraggiungibile) si legge solo per codice.
    const open = !f.hidden && f.unavailable === null;
    return { kind: "drive", ...empty, canOpen: open, id: open ? f.id : null, title: open ? f.name : null, code: `${f.code}-F${f.number}`, at: f.at.toISOString() };
  });
}

/** L'ultima prima versione dello spazio come la legge chi guarda, o null (nessuna, o chi non legge i Docs). */
export async function firstVersionView(db: Db, viewer: Viewer, projectId: string): Promise<ProductFirstVersionView | null> {
  const perms = await permsOf(db, viewer, projectId);
  if (!perms.has("docs.view")) return null;
  const fv = await latestOf(db, projectId);
  if (!fv) return null;
  const canEdit = perms.has("docs.edit");
  const pageIds = fv.written.map((w) => w.pageId);
  const alive = new Map(
    pageIds.length > 0
      ? (await db.execute(sql`select p.id, p.title, pr.code || '-D' || c.number as code from product_pages p join projects pr on pr.id = p.project_id join doc_page_codes c on c.product_page_id = p.id where p.id in (${sql.join(pageIds.map((id) => sql`${id}`), sql`, `)})`) as unknown as { id: string; code: string }[]).map((r) => [r.id, r.code])
      : [],
  );
  const nameOf = await namesFor(db, viewer, [fv.startedBy]);
  const done = fv.written.length;
  return {
    projectId,
    groupId: fv.id,
    byId: fv.startedBy,
    byName: nameOf(fv.startedBy),
    status: fv.status,
    pagesDone: done,
    pagesTotal: fv.plan.length,
    interrupted: fv.interrupted,
    sources: await sourceViewsOf(db, viewer, fv),
    pages: fv.plan.map((p, i) => {
      const pageId = fv.written[i]?.pageId ?? null;
      const code = pageId ? (alive.get(pageId) ?? null) : null;
      return { title: p.title, depth: p.depth, pageId: code ? pageId : null, code, state: i < done ? "written" : fv.status === "writing" && i === done ? "writing" : "waiting" };
    }),
    acceptedPageIds: [...fv.acceptedPageIds],
    bannerPageIds: fv.status === "undone" ? [] : pageIds.filter((id) => alive.has(id) && !fv.acceptedPageIds.includes(id)),
    undo: await undoOf(db, viewer, fv, canEdit),
    permissions: { edit: canEdit, stop: canEdit && fv.status === "writing" },
  };
}

/** «Undo the first version»: toglie le sue pagine, dalle foglie alla radice. Vale anche mentre scrive (si ferma). */
export async function undoFirstVersion(db: Db, viewer: Viewer, projectId: string): Promise<void> {
  const perms = await permsOf(db, viewer, projectId);
  if (!perms.has("docs.view")) throw notFound();
  if (!perms.has("docs.edit")) throw new ProductDocsError(403, "forbidden", "Forbidden");
  const fv = await latestOf(db, projectId);
  if (!fv) throw notFound();
  const undo = await undoOf(db, viewer, fv, true);
  if (!undo.enabled) throw new FirstVersionUndoBlockedError(undo);
  // Prima la riga (il worker non scrive più: `writeFirstVersionPage` la trova annullata), poi le pagine.
  const [claimed] = await db
    .update(productFirstVersions)
    .set({ status: "undone", undoneBy: viewer.id, pastedText: null, finishedAt: new Date() })
    .where(and(eq(productFirstVersions.id, fv.id), ne(productFirstVersions.status, "undone")))
    .returning({ written: productFirstVersions.written });
  if (!claimed) throw new FirstVersionUndoBlockedError({ ...undo, enabled: false, reason: "already_undone" });
  for (const w of [...claimed.written].reverse()) {
    const [page] = await db.select({ id: productPages.id }).from(productPages).where(eq(productPages.id, w.pageId));
    if (page) await deleteProductPage(db, page.id);
  }
}

/** «Stop»: la prima versione si ferma dopo la pagina in corso. Idempotente. */
export async function stopFirstVersion(db: Db, viewer: Viewer, projectId: string): Promise<void> {
  const perms = await permsOf(db, viewer, projectId);
  if (!perms.has("docs.view")) throw notFound();
  if (!perms.has("docs.edit")) throw new ProductDocsError(403, "forbidden", "Forbidden");
  await db.update(productFirstVersions).set({ stopRequested: true }).where(and(eq(productFirstVersions.projectId, projectId), eq(productFirstVersions.status, "writing")));
}

/** «Accept this page»: la riga in cima sparisce per tutti. Una pagina che non è di una prima versione viva è 422. */
export async function acceptFirstVersionPage(db: Db, viewer: Viewer, pageId: string): Promise<void> {
  const [page] = await db.select({ projectId: productPages.projectId }).from(productPages).where(eq(productPages.id, pageId));
  if (!page) throw notFound();
  const perms = await permsOf(db, viewer, page.projectId);
  if (!perms.has("docs.view")) throw notFound();
  if (!perms.has("docs.edit")) throw new ProductDocsError(403, "forbidden", "Forbidden");
  const fv = await latestOf(db, page.projectId);
  if (!fv || fv.status === "undone" || !fv.written.some((w) => w.pageId === pageId)) throw new ProductDocsError(422, "invalid_page", "The page is not part of a first version");
  if (fv.acceptedPageIds.includes(pageId)) return;
  await db
    .update(productFirstVersions)
    .set({ acceptedPageIds: sql`array_append(${productFirstVersions.acceptedPageIds}, ${pageId}::uuid)` })
    .where(and(eq(productFirstVersions.id, fv.id), sql`not (${pageId}::uuid = any(${productFirstVersions.acceptedPageIds}))`));
}
