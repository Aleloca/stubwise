import { docPageCodes, productPageBlockIds, productPageFollows, productPageRevisions, productPages, projectDecisions, projects, users, type Db } from "@stubwise/db";
import {
  DOC_CODE_RE,
  blockChanges,
  canMoveUnder,
  excerptOfBlocks,
  productBlockSchema,
  type ProductBlock,
  type ProductPageRef,
  type ProductPageView,
  type ProductSpaceView,
} from "@stubwise/shared";
import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { personName } from "./people.js";
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

/** Le pagine di un progetto con il loro codice (`<PRJ>-D<n>`), come le vede l'albero. */
async function pageRowsOf(db: Db, projectId: string): Promise<(PageRow & { code: string })[]> {
  const rows = await db
    .select({ page: productPages, number: docPageCodes.number, projectCode: projects.code })
    .from(productPages)
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .innerJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    .where(eq(productPages.projectId, projectId));
  return rows.map((r) => ({ ...r.page, code: `${r.projectCode}-D${r.number}` }));
}

export const pageRefOf = (row: PageRow & { code: string }): ProductPageRef => ({
  id: row.id,
  code: row.code,
  projectId: row.projectId,
  parentId: row.parentId,
  order: row.order,
  title: row.title,
  excerpt: excerptOfBlocks(readBlocks(row)),
  updatedAt: row.updatedAt.toISOString(),
  updatedById: row.updatedBy,
});

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
  };
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
    for (const id of decisionIds) {
      const d = rowsD.find((r) => r.id === id);
      // Una decisione di un progetto che chi guarda non vede: null (R-G5).
      if (!d || !(await projectPermissionsFor(db, viewer, d.projectId))) {
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
  const [follow] = await db
    .select({ pageId: productPageFollows.pageId })
    .from(productPageFollows)
    .where(and(eq(productPageFollows.pageId, page.id), eq(productPageFollows.userId, viewer.id)));
  const hasChildren = rows.some((r) => r.parentId === page.id);
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
    const parentId = await checkParent(tx, projectId, input.parentId);
    const first: ProductBlock = { id: newBlockId(), type: "paragraph", content: { text: "", marks: [] } };
    const [page] = await tx
      .insert(productPages)
      .values({ projectId, parentId, title, blocks: [first], createdBy: viewer.id, updatedBy: viewer.id })
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
export async function updateProductPage(
  db: Db,
  viewer: Viewer,
  pageId: string,
  input: { title?: string; move?: { parentId: string | null; index: number } },
): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [page] = await tx.select().from(productPages).where(eq(productPages.id, pageId)).for("update");
    if (!page) throw notFound();
    if (input.title !== undefined) {
      const after = cleanTitle(input.title);
      if (after !== page.title) {
        await tx.update(productPages).set({ title: after, updatedBy: viewer.id, updatedAt: new Date() }).where(eq(productPages.id, pageId));
        const seq = await nextRevSeq(tx, pageId);
        await tx.insert(productPageRevisions).values({ pageId, seq, lastSeq: seq, actorId: viewer.id, kind: "rename", title: { before: page.title, after } });
      }
    }
    if (input.move) {
      const parentId = await checkParent(tx, page.projectId, input.move.parentId);
      const refs = (await pageRowsOf(tx, page.projectId)).map(pageRefOf);
      if (!canMoveUnder(refs, pageId, parentId)) throw new ProductDocsError(409, "cycle", "A page can't go under itself or one of its pages");
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
      }
    }
  });
}

/** Elimina una pagina senza sottopagine (409 `has_children`). Il codice resta preso. */
export async function deleteProductPage(db: Db, pageId: string): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [page] = await tx.select().from(productPages).where(eq(productPages.id, pageId)).for("update");
    if (!page) throw notFound();
    const [child] = await tx.select({ id: productPages.id }).from(productPages).where(eq(productPages.parentId, pageId)).limit(1);
    if (child) throw new ProductDocsError(409, "has_children", "The page has pages under it");
    await tx.delete(productPages).where(eq(productPages.id, pageId));
    await renumber(tx, await siblingIds(tx, page.projectId, page.parentId));
  });
}
