import { driveFiles, productPages, projects, type Db } from "@stubwise/db";
import {
  PRODUCT_EXPORT_PAGES_MAX,
  buildProductTree,
  productBlockSchema,
  type ProductBlock,
  type ProductExportPage,
  type ProductExportSpace,
  type ProductTreeNode,
} from "@stubwise/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { inProjects, visibleProjectIds } from "../auth/access.js";
import type { SessionUser } from "../auth/session.js";
import { decisionRefsFor, pageRefOf, pageRowsOf, ProductDocsError } from "./product-docs.js";

/**
 * Area 11, F3 — l'esportazione (D-4 = a: il PDF e il Word li compone il
 * client). Le rotte chiedono `docs.view`. Ciò che esce:
 * - i blocchi della pagina, MAI i commenti (stanno in un'altra tabella e qui
 *   non si leggono);
 * - le decisioni citate come le vede chi esporta (`decisionRefsFor`, la regola
 *   della vista della pagina: `null` per un progetto che non vede);
 * - i nomi dei file del Drive citati, solo per chi è membro del progetto del
 *   file (la regola delle citazioni del Drive), `null` altrimenti o se il file
 *   è stato tolto (richiesta di 94);
 * - nessun URL firmato: le immagini si leggono dalla rotta coi byte, coi
 *   permessi della pagina (ruling del Task 2, approvato da 46).
 * Lo spazio intero in ordine d'albero, al più `PRODUCT_EXPORT_PAGES_MAX` pagine
 * (oltre, 413 col numero).
 */

type Viewer = Pick<SessionUser, "id" | "instancePermissions">;

export class ProductExportTooLarge extends Error {
  constructor(readonly count: number) {
    super(`A space exports at most ${PRODUCT_EXPORT_PAGES_MAX} pages`);
  }
}

const readBlocks = (raw: unknown): ProductBlock[] =>
  (Array.isArray(raw) ? raw : []).flatMap((b) => {
    const parsed = productBlockSchema.safeParse(b);
    return parsed.success ? [parsed.data as ProductBlock] : [];
  });

/** I nomi dei file del Drive citati dai blocchi, come li vede chi esporta. */
async function fileNamesFor(db: Db, viewer: Viewer, blocks: readonly ProductBlock[]): Promise<ProductExportPage["files"]> {
  const ids = [...new Set(blocks.flatMap((b) => (b.type === "drive" ? [b.fileId] : [])))];
  const files: ProductExportPage["files"] = {};
  if (ids.length === 0) return files;
  const visible = await visibleProjectIds(db, viewer);
  const rows = await db
    .select({ id: driveFiles.id, name: driveFiles.name })
    .from(driveFiles)
    .where(and(inArray(driveFiles.id, ids), isNull(driveFiles.deletedAt), inProjects(driveFiles.projectId, visible)));
  const names = new Map(rows.map((r) => [r.id, r.name]));
  for (const id of ids) files[id] = names.has(id) ? { name: names.get(id)! } : null;
  return files;
}

type PageRow = Pick<typeof productPages.$inferSelect, "id" | "title" | "blocks" | "updatedAt">;

async function exportOf(db: Db, viewer: Viewer, row: PageRow, code: string, projectCode: string): Promise<ProductExportPage> {
  const blocks = readBlocks(row.blocks);
  return {
    page: { id: row.id, code, title: row.title, projectCode, updatedAt: row.updatedAt.toISOString() },
    blocks: blocks as unknown as Record<string, unknown>[],
    decisions: await decisionRefsFor(db, viewer, blocks),
    files: await fileNamesFor(db, viewer, blocks),
  };
}

/** Una pagina (la rotta ha chiesto `docs.view` nel suo progetto). */
export async function exportProductPage(db: Db, viewer: Viewer, pageId: string): Promise<ProductExportPage> {
  const [page] = await db
    .select({ id: productPages.id, title: productPages.title, blocks: productPages.blocks, updatedAt: productPages.updatedAt, projectId: productPages.projectId, projectCode: projects.code })
    .from(productPages)
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .where(eq(productPages.id, pageId));
  if (!page) throw new ProductDocsError(404, "not_found", "Not found");
  const ref = (await pageRowsOf(db, page.projectId)).find((r) => r.id === page.id);
  if (!ref) throw new ProductDocsError(404, "not_found", "Not found");
  return exportOf(db, viewer, page, ref.code, page.projectCode);
}

/** Lo spazio intero, in ordine d'albero (la rotta ha chiesto `docs.view`). */
export async function exportProductSpace(db: Db, viewer: Viewer, projectId: string): Promise<ProductExportSpace> {
  const [project] = await db.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  if (!project) throw new ProductDocsError(404, "not_found", "Not found");
  const refs = (await pageRowsOf(db, projectId)).map(pageRefOf);
  if (refs.length > PRODUCT_EXPORT_PAGES_MAX) throw new ProductExportTooLarge(refs.length);
  const ordered: { id: string; code: string; depth: number }[] = [];
  const walk = (nodes: ProductTreeNode[], depth: number) => {
    for (const n of nodes) {
      ordered.push({ id: n.page.id, code: n.page.code, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(buildProductTree(refs), 0);
  const rows = ordered.length > 0
    ? await db.select({ id: productPages.id, title: productPages.title, blocks: productPages.blocks, updatedAt: productPages.updatedAt }).from(productPages).where(inArray(productPages.id, ordered.map((o) => o.id)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pages: ProductExportSpace["pages"] = [];
  for (const o of ordered) {
    const row = byId.get(o.id);
    if (row) pages.push({ ...(await exportOf(db, viewer, row, o.code, project.code)), depth: o.depth });
  }
  return { projectCode: project.code, pages };
}
