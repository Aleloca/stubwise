import { docPageCodes, productComments, productDocJobs, productPageBlockIds, productPageFollows, productPageImages, productPageRevisions, productPages, projectDecisions, projects, users, type Db } from "@stubwise/db";
import {
  DOC_CODE_RE,
  PRODUCT_PAGES_MAX,
  PRODUCT_TREE_DEPTH_MAX,
  blockChanges,
  canMoveUnder,
  productBlockSchema,
  productSearchText,
  type ProductBlock,
  type ProductPageRef,
  type ProductPageView,
  type ProductClaudeHeld,
  type ProductSpaceView,
} from "@stubwise/shared";
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { projectPermissionsByProject } from "@stubwise/notifications";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { personName } from "./people.js";
import { notifyProductGone, notifyProductRevision } from "./product-live-notify.js";
import { visiblePersonIds } from "./people-visibility.js";

/**
 * Area 11, F1 — lo spazio Product di un progetto: leggere, creare, rinominare,
 * spostare, eliminare. La regola è quella del prototipo
 * (`apps/desktop/src/renderer/data/productDocs/reads.ts` e `writes.ts`):
 * `docs.view` per leggere, `docs.edit` per scrivere (la rotta lo chiede, e
 * qui si ricontrolla per il codice), invisibile = 404. Il corpo si scrive
 * SOLO a operazioni (`product-docs-ops.ts`, Task 4).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;
type PageRow = typeof productPages.$inferSelect;

export class ProductDocsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const notFound = () => new ProductDocsError(404, "not_found", "Not found");

const readBlocks = (row: PageRow): ProductBlock[] =>
  (Array.isArray(row.blocks) ? row.blocks : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

/**
 * Review di F1 (I1): il lock dell'ALBERO di un progetto, per crea, sposta ed
 * elimina, PRIMA di leggerlo. Senza, due spostamenti concorrenti (A sotto B,
 * C sotto A) leggono lo stesso albero e chiudono un giro che toglie pagine
 * dall'albero; e gli `order` dei fratelli si sovrappongono.
 */
export async function lockProductTree(tx: Db, projectId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stubwise-product-tree:${projectId}`}))`);
}

type TreeRow = Pick<PageRow, "id" | "projectId" | "parentId" | "order" | "title" | "updatedAt" | "updatedBy"> & { code: string; excerpt: string };

/**
 * Le pagine di un progetto con il loro codice (`<PRJ>-D<n>`), come le vede
 * l'albero: SOLO le sue colonne (review di F1, I3), mai i blocchi di tutte le
 * pagine. L'estratto (il primo paragrafo non vuoto, al più 200 caratteri, la
 * regola di `excerptOfBlocks`) lo calcola il database.
 */
export async function pageRowsOf(db: Db, projectId: string): Promise<TreeRow[]> {
  const rows = await db
    .select({
      id: productPages.id,
      projectId: productPages.projectId,
      parentId: productPages.parentId,
      order: productPages.order,
      title: productPages.title,
      updatedAt: productPages.updatedAt,
      updatedBy: productPages.updatedBy,
      number: docPageCodes.number,
      projectCode: projects.code,
      excerpt: sql<string | null>`(select left(trim(b->'content'->>'text'), 200) from jsonb_array_elements(${productPages.blocks}) as b where b->>'type' = 'paragraph' and trim(coalesce(b->'content'->>'text', '')) <> '' limit 1)`,
    })
    .from(productPages)
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .innerJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    .where(eq(productPages.projectId, projectId));
  return rows.map(({ number, projectCode, excerpt, ...r }) => ({ ...r, code: `${projectCode}-D${number}`, excerpt: excerpt ?? "" }));
}

export const pageRefOf = (row: TreeRow): ProductPageRef => ({
  id: row.id,
  code: row.code,
  projectId: row.projectId,
  parentId: row.parentId,
  order: row.order,
  title: row.title,
  excerpt: row.excerpt,
  updatedAt: row.updatedAt.toISOString(),
  updatedById: row.updatedBy,
});

/** La profondità di una pagina (la radice è 1), dall'albero già letto. */
function depthOf(rows: readonly TreeRow[], pageId: string | null): number {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let depth = 0;
  const seen = new Set<string>();
  for (let at = pageId; at !== null && !seen.has(at); at = byId.get(at)?.parentId ?? null) {
    seen.add(at);
    depth++;
  }
  return depth;
}

/** Quanti livelli sotto la pagina (lei compresa: una foglia è 1). */
function heightOf(rows: readonly TreeRow[], pageId: string): number {
  const children = rows.filter((r) => r.parentId === pageId);
  return 1 + Math.max(0, ...children.map((c) => heightOf(rows, c.id)));
}

/** Le pagine più recenti prima; a pari data il codice più alto (la più nuova). */
const byRecent = (a: ProductPageRef, b: ProductPageRef) =>
  b.updatedAt.localeCompare(a.updatedAt) || b.code.localeCompare(a.code, "en", { numeric: true });

/** Lo spazio di un progetto (la rotta ha già chiesto `docs.view`). */
export async function productSpace(db: Db, projectId: string, perms: ReadonlySet<string>): Promise<ProductSpaceView> {
  const [project] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound();
  const refs = (await pageRowsOf(db, projectId)).map(pageRefOf);
  return {
    projectId,
    projectCode: project.code,
    pages: refs,
    pageCount: refs.length,
    recent: [...refs].sort(byRecent).slice(0, 5),
    permissions: { edit: perms.has("docs.edit") },
    claudeHeld: await productClaudeHeld(db, projectId),
  };
}

/** Il motivo più grave per primo. */
const HELD_ORDER = ["budget", "paused", "limit", "section_busy"] as const;

/** La riga «riprende quando…» di uno spazio: i lavori di Claude fermi nel progetto e il motivo più grave. */
export async function productClaudeHeld(db: Pick<Db, "select">, projectId: string): Promise<ProductClaudeHeld> {
  const rows = await db
    .select({ reason: productDocJobs.heldReason, n: sql<number>`count(*)::int` })
    .from(productDocJobs)
    .where(and(eq(productDocJobs.projectId, projectId), eq(productDocJobs.status, "held")))
    .groupBy(productDocJobs.heldReason);
  const count = rows.reduce((s, r) => s + r.n, 0);
  if (count === 0) return null;
  const reason = HELD_ORDER.find((r) => rows.some((x) => x.reason === r)) ?? "limit";
  return { reason, count };
}

/**
 * Una pagina per codice. Un progetto che chi guarda non vede, o un codice che
 * non c'è: 404. In un progetto visibile SENZA `docs.view`: 403, anche se la
 * pagina non c'è (la risposta non dice se c'è), come il prototipo.
 */
export async function productPageByCode(db: Db, viewer: Viewer, code: string): Promise<ProductPageView> {
  const match = DOC_CODE_RE.exec(code.trim().toUpperCase());
  if (!match) throw notFound();
  const [, projectCode, number] = match;
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.code, projectCode!));
  if (!project) throw notFound();
  const perms = await projectPermissionsFor(db, viewer, project.id);
  if (!perms) throw notFound();
  if (!perms.has("docs.view")) throw new ProductDocsError(403, "forbidden", "Missing permission");
  const [hit] = await db
    .select({ pageId: docPageCodes.productPageId })
    .from(docPageCodes)
    .where(and(eq(docPageCodes.projectId, project.id), eq(docPageCodes.number, Number(number)), isNotNull(docPageCodes.productPageId)));
  if (!hit?.pageId) throw notFound();
  return productPageView(db, viewer, hit.pageId, perms);
}

/**
 * Le decisioni citate dai blocchi, come le vede chi guarda (R-G5): `null` per
 * una decisione di un progetto che non vede, il nome di chi ha deciso solo se
 * lo vede. La usano la vista della pagina e l'esportazione (F3).
 */
export async function decisionRefsFor(db: Db, viewer: Viewer, blocks: readonly ProductBlock[]): Promise<ProductPageView["decisions"]> {
  const decisionIds = [...new Set(blocks.flatMap((b) => (b.type === "decision" ? [b.decisionId] : [])))];
  const decisions: ProductPageView["decisions"] = {};
  if (decisionIds.length > 0) {
    const rowsD = await db
      .select({ id: projectDecisions.id, title: projectDecisions.title, decidedAt: projectDecisions.decidedAt, projectId: projectDecisions.projectId, projectCode: projects.code, by: projectDecisions.decidedByUserId, email: users.email, displayName: users.displayName })
      .from(projectDecisions)
      .innerJoin(projects, eq(projects.id, projectDecisions.projectId))
      .leftJoin(users, eq(users.id, projectDecisions.decidedByUserId))
      .where(inArray(projectDecisions.id, decisionIds));
    const people = await visiblePersonIds(db, viewer);
    // Review di F3 (M6): i permessi di tutti i progetti in UNA lettura.
    const perms = await projectPermissionsByProject(db, viewer.id, rowsD.map((r) => r.projectId));
    for (const id of decisionIds) {
      const d = rowsD.find((r) => r.id === id);
      // Una decisione di un progetto che chi guarda non vede: null (R-G5).
      if (!d || !perms.get(d.projectId)) {
        decisions[id] = null;
        continue;
      }
      const seesBy = d.by !== null && (people === "all" || people.includes(d.by));
      decisions[id] = {
        title: d.title,
        decidedAt: d.decidedAt.toISOString(),
        decidedByName: seesBy && d.email ? personName({ email: d.email, displayName: d.displayName }) : null,
        projectCode: d.projectCode,
      };
    }
  }
  return decisions;
}

/** La vista di una pagina per chi guarda (con `docs.view` già controllato). */
export async function productPageView(db: Db, viewer: Viewer, pageId: string, perms: ReadonlySet<string>): Promise<ProductPageView> {
  const [page] = await db.select().from(productPages).where(eq(productPages.id, pageId));
  if (!page) throw notFound();
  const rows = await pageRowsOf(db, page.projectId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const self = byId.get(page.id);
  if (!self) throw notFound();
  const breadcrumbs: ProductPageRef[] = [];
  const seen = new Set<string>([page.id]);
  for (let at = page.parentId; at !== null && !seen.has(at); ) {
    seen.add(at);
    const parent = byId.get(at);
    if (!parent) break;
    breadcrumbs.unshift(pageRefOf(parent));
    at = parent.parentId;
  }
  const blocks = readBlocks(page);
  const decisions = await decisionRefsFor(db, viewer, blocks);
  const [follow] = await db
    .select({ pageId: productPageFollows.pageId })
    .from(productPageFollows)
    .where(and(eq(productPageFollows.pageId, page.id), eq(productPageFollows.userId, viewer.id)));
  const hasChildren = rows.some((r) => r.parentId === page.id);
  // I fili aperti (richiesta di 94): le radici non risolte né eliminate, con l'ancora viva o no.
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(productComments)
    .where(and(eq(productComments.pageId, page.id), isNull(productComments.replyToId), isNull(productComments.resolvedAt), isNull(productComments.deletedAt)));
  const openComments = open?.n ?? 0;
  const edit = perms.has("docs.edit");
  return {
    id: page.id,
    code: self.code,
    projectId: page.projectId,
    parentId: page.parentId,
    order: page.order,
    title: page.title,
    blocks,
    seq: page.revSeq,
    createdById: page.createdBy,
    createdAt: page.createdAt.toISOString(),
    updatedById: page.updatedBy,
    updatedAt: page.updatedAt.toISOString(),
    breadcrumbs,
    decisions,
    following: follow !== undefined,
    permissions: { edit, delete: edit && !hasChildren },
    // Perché «Elimina» è spenta (richiesta di 94): prima il permesso, poi le sottopagine.
    deleteBlockedBy: !edit ? "permission" : hasChildren ? "children" : null,
    openComments,
    // F5: un lavoro fermo non si attribuisce a una pagina prima che il modello l'abbia letta: la riga sta sullo spazio.
    claudeHeld: null,
    // F6: le bozze di schermata arrivano col Task 2.
    wireframes: [],
  };
}

const cleanTitle = (title: string): string => {
  const t = title.trim();
  if (!t) throw new ProductDocsError(400, "invalid_title", "The title is empty");
  return t.slice(0, 200);
};

/** Rimette `order` 0, 1, 2… ai fratelli nell'ordine dato. */
async function renumber(tx: Db, ids: readonly string[]): Promise<void> {
  for (const [i, id] of ids.entries()) await tx.update(productPages).set({ order: i }).where(eq(productPages.id, id));
}

/** I fratelli (senza `except`) sotto `parentId`, nell'ordine dell'albero. */
async function siblingIds(tx: Db, projectId: string, parentId: string | null, except?: string): Promise<string[]> {
  const rows = await tx
    .select({ id: productPages.id })
    .from(productPages)
    .where(and(eq(productPages.projectId, projectId), parentId === null ? sql`${productPages.parentId} is null` : eq(productPages.parentId, parentId), except ? ne(productPages.id, except) : undefined))
    .orderBy(asc(productPages.order), asc(productPages.createdAt));
  return rows.map((r) => r.id);
}

/** Il genitore scelto: una pagina dello stesso progetto, o la radice. */
async function checkParent(tx: Db, projectId: string, parentId: string | null | undefined): Promise<string | null> {
  if (parentId === undefined || parentId === null) return null;
  const [parent] = await tx.select({ id: productPages.id }).from(productPages).where(and(eq(productPages.id, parentId), eq(productPages.projectId, projectId)));
  if (!parent) throw notFound();
  return parent.id;
}

/** La revisione successiva della pagina (`rev_seq`, sotto il lock della riga). */
async function nextRevSeq(tx: Db, pageId: string): Promise<number> {
  const [row] = await tx.update(productPages).set({ revSeq: sql`${productPages.revSeq} + 1` }).where(eq(productPages.id, pageId)).returning({ seq: productPages.revSeq });
  return row!.seq;
}

/**
 * Crea una pagina (la rotta chiede `docs.edit`): un paragrafo vuoto come primo
 * blocco, una revisione `create`, e chi crea la segue (il prototipo). `index`
 * è la posizione fra i fratelli (in fondo se manca). Il codice lo dà il
 * trigger della 0202.
 */
export async function createProductPage(
  db: Db,
  viewer: Viewer,
  projectId: string,
  input: { title: string; parentId?: string | null; index?: number },
  newBlockId: () => string,
): Promise<{ id: string; code: string }> {
  const title = cleanTitle(input.title);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockProductTree(tx, projectId);
    const parentId = await checkParent(tx, projectId, input.parentId);
    // Review di F1 (M9): le pagine di un progetto e la profondità dell'albero.
    const tree = await pageRowsOf(tx, projectId);
    if (tree.length >= PRODUCT_PAGES_MAX) throw new ProductDocsError(409, "too_many_pages", `A project has at most ${PRODUCT_PAGES_MAX} pages`);
    if (depthOf(tree, parentId) + 1 > PRODUCT_TREE_DEPTH_MAX) throw new ProductDocsError(409, "too_deep", `Pages nest at most ${PRODUCT_TREE_DEPTH_MAX} levels`);
    const first: ProductBlock = { id: newBlockId(), type: "paragraph", content: { text: "", marks: [] } };
    const [page] = await tx
      .insert(productPages)
      .values({ projectId, parentId, title, blocks: [first], searchText: productSearchText(title, [first]), createdBy: viewer.id, updatedBy: viewer.id })
      .returning();
    await tx.insert(productPageBlockIds).values({ pageId: page!.id, blockId: first.id });
    const siblings = await siblingIds(tx, projectId, parentId, page!.id);
    siblings.splice(Math.min(input.index ?? siblings.length, siblings.length), 0, page!.id);
    await renumber(tx, siblings);
    const seq = await nextRevSeq(tx, page!.id);
    await tx.insert(productPageRevisions).values({ pageId: page!.id, seq, lastSeq: seq, actorId: viewer.id, kind: "create", changes: blockChanges([], [first]) as unknown[] });
    await tx.insert(productPageFollows).values({ pageId: page!.id, userId: viewer.id }).onConflictDoNothing();
    const [code] = await tx
      .select({ number: docPageCodes.number, projectCode: projects.code })
      .from(docPageCodes)
      .innerJoin(projects, eq(projects.id, docPageCodes.projectId))
      .where(eq(docPageCodes.productPageId, page!.id));
    return { id: page!.id, code: `${code!.projectCode}-D${code!.number}` };
  });
}

/**
 * Rinomina e/o sposta (la rotta chiede `docs.edit`). Un titolo uguale non
 * scrive niente; un genitore nuovo scrive `move`, un riordino fra gli stessi
 * fratelli no (ruling P30 del prototipo). Sotto sé stessa o un discendente:
 * 409 `cycle`.
 */
/** Una rinomina o uno spostamento scritti, col loro seq (per il canale dal vivo). */
export interface PageChangeRevision {
  seq: number;
  kind: "rename" | "move";
  title: string;
  parentId: string | null;
}

export async function updateProductPage(
  db: Db,
  viewer: Viewer,
  pageId: string,
  input: { title?: string; move?: { parentId: string | null; index: number } },
): Promise<PageChangeRevision[]> {
  // Review di F4 (I5): le revisioni che QUESTA scrittura ha fatto, coi loro seq: la
  // rotta pubblica queste, non il seq della pagina riletto dopo il commit.
  const written: PageChangeRevision[] = [];
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [where] = await tx.select({ projectId: productPages.projectId }).from(productPages).where(eq(productPages.id, pageId));
    if (!where) throw notFound();
    // Il lock dell'albero PRIMA di rileggere la pagina e l'albero (review di F1, I1).
    if (input.move) await lockProductTree(tx, where.projectId);
    const [page] = await tx.select().from(productPages).where(eq(productPages.id, pageId)).for("no key update");
    if (!page) throw notFound();
    if (input.title !== undefined) {
      const after = cleanTitle(input.title);
      if (after !== page.title) {
        await tx.update(productPages).set({ title: after, searchText: productSearchText(after, readBlocks(page)), updatedBy: viewer.id, updatedAt: new Date() }).where(eq(productPages.id, pageId));
        const seq = await nextRevSeq(tx, pageId);
        await tx.insert(productPageRevisions).values({ pageId, seq, lastSeq: seq, actorId: viewer.id, kind: "rename", title: { before: page.title, after } });
        await notifyProductRevision(tx, { pageId, seq, kind: "rename", actorId: viewer.id, sessionId: null, title: after });
        written.push({ seq, kind: "rename", title: after, parentId: page.parentId });
      }
    }
    if (input.move) {
      const parentId = await checkParent(tx, page.projectId, input.move.parentId);
      const tree = await pageRowsOf(tx, page.projectId);
      if (!canMoveUnder(tree.map(pageRefOf), pageId, parentId)) throw new ProductDocsError(409, "cycle", "A page can't go under itself or one of its pages");
      if (depthOf(tree, parentId) + heightOf(tree, pageId) > PRODUCT_TREE_DEPTH_MAX) throw new ProductDocsError(409, "too_deep", `Pages nest at most ${PRODUCT_TREE_DEPTH_MAX} levels`);
      const beforeId = page.parentId;
      if (beforeId !== parentId) await renumber(tx, await siblingIds(tx, page.projectId, beforeId, pageId));
      const siblings = await siblingIds(tx, page.projectId, parentId, pageId);
      siblings.splice(Math.min(input.move.index, siblings.length), 0, pageId);
      await tx.update(productPages).set({ parentId }).where(eq(productPages.id, pageId));
      await renumber(tx, siblings);
      if (beforeId !== parentId) {
        await tx.update(productPages).set({ updatedBy: viewer.id, updatedAt: new Date() }).where(eq(productPages.id, pageId));
        const seq = await nextRevSeq(tx, pageId);
        await tx.insert(productPageRevisions).values({ pageId, seq, lastSeq: seq, actorId: viewer.id, kind: "move", parent: { beforeId, afterId: parentId } });
        await notifyProductRevision(tx, { pageId, seq, kind: "move", actorId: viewer.id, sessionId: null, parentId });
        written.push({ seq, kind: "move", title: input.title !== undefined ? cleanTitle(input.title) : page.title, parentId });
      }
    }
  });
  return written;
}

/**
 * Elimina una pagina senza sottopagine (409 `has_children`). Il codice resta
 * preso. Restituisce le chiavi dello storage delle sue immagini (review di F1,
 * I2): la cascata toglie le righe, gli oggetti li toglie chi chiama DOPO il
 * commit (`removeOrRecordOrphan`), come per l'eliminazione di un progetto.
 */
export async function deleteProductPage(db: Db, pageId: string): Promise<{ storageKeys: string[] }> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [where] = await tx.select({ projectId: productPages.projectId }).from(productPages).where(eq(productPages.id, pageId));
    if (!where) throw notFound();
    await lockProductTree(tx, where.projectId);
    const [page] = await tx.select().from(productPages).where(eq(productPages.id, pageId)).for("update");
    if (!page) throw notFound();
    const [child] = await tx.select({ id: productPages.id }).from(productPages).where(eq(productPages.parentId, pageId)).limit(1);
    if (child) throw new ProductDocsError(409, "has_children", "The page has pages under it");
    const images = await tx.select({ key: productPageImages.storageKey }).from(productPageImages).where(eq(productPageImages.pageId, pageId));
    await tx.delete(productPages).where(eq(productPages.id, pageId));
    await notifyProductGone(tx, pageId);
    await renumber(tx, await siblingIds(tx, page.projectId, page.parentId));
    return { storageKeys: images.map((i) => i.key) };
  });
}
