import { docPageCodes, productPageRevisions, productPages, projects, type Db } from "@stubwise/db";
import type { FirstVersionSource, ProductPageUpdateSource } from "@stubwise/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { RouteAccess } from "../auth/access.js";
import { fromParam, fromProductPage, fromProductRevision } from "../auth/project-resolvers.js";
import { requestProductPageUpdate } from "../services/product-claude-actions.js";
import { ProductUndoBlockedError, undoDrawnWireframe, undoProductRevision } from "../services/product-claude.js";
import { ProductDocsError } from "../services/product-docs.js";
import { ProductSectionBusyError } from "../services/product-docs-ops.js";
import { FirstVersionUndoBlockedError, startFirstVersion, undoFirstVersion } from "../services/product-first-version.js";
import { drawWireframe } from "../services/product-wireframes.js";
import type { CatalogEntry, CatalogRefusal } from "./catalog.js";

/**
 * Area 11, F6, Task 4 — le sei voci della doc di prodotto (il prototipo:
 * `data/claude/catalogProduct.ts`). Ognuna chiama IL SERVIZIO della sua rotta
 * (permessi, rifiuti, cronologia e notifiche di sempre), con `docs.edit` nel
 * progetto come la rotta. Le classi (F6-1 = a, maintainer): tutte B.
 * - «Scrivi la prima versione» e «Disegna questa schermata» fanno partire il
 *   modello (`startsWork`: la scheda dice `starts_work`), e si annullano dopo
 *   con l'inverso (`undoFirstVersion`, `deleteWireframe`).
 * - «Aggiorna la pagina da questa email» accoda UN lavoro della doc su UNA
 *   fonte e UNA pagina: anche lui fa partire il modello. La modifica arriva
 *   dopo, dal worker, col segno di Claude e il suo «Undo» sulla pagina; da
 *   qui non si annulla (la revisione non c'è ancora), e la si annulla poi
 *   con `undoProductUpdate` (la revisione) o dalla cronologia.
 * - Gli inversi sono voci (P39), B perché non si annullano a loro volta.
 * Col budget del mese finito nessuna parte (`invalid: monthly_budget`).
 * Nessuna scrive nel registro decisioni (`claude-actions-never.test.ts`).
 */

const docsEdit = (project: Extract<RouteAccess, { kind: "project" }>["project"]): Extract<RouteAccess, { kind: "project" }> => ({
  kind: "project",
  permission: "docs.edit",
  project,
});

const refused = (code: CatalogRefusal["code"], message: string) => ({ ok: false as const, refusal: { code, message } });

/** Gli errori dei servizi della doc nei codici del catalogo. */
function productRefusal(error: unknown): { ok: false; refusal: CatalogRefusal } {
  if (error instanceof ProductSectionBusyError) return refused("busy", error.code);
  if (error instanceof ProductUndoBlockedError || error instanceof FirstVersionUndoBlockedError) return refused("conflict", error.code);
  if (error instanceof ProductDocsError) {
    if (error.code === "ai_blocked") return refused("invalid", "monthly_budget");
    if (error.status === 403) return refused("forbidden", error.code);
    if (error.status === 404) return refused("not_found", error.code);
    if (error.status === 409) return refused("conflict", error.code);
    return refused("invalid", error.code);
  }
  throw error;
}

/** Il codice della pagina (AUD-D5), per la riga «fatto» e il modello. */
async function pageCodes(tx: Db, pageId: string): Promise<string[]> {
  const [row] = await tx
    .select({ projectCode: projects.code, number: docPageCodes.number })
    .from(productPages)
    .innerJoin(projects, eq(projects.id, productPages.projectId))
    .leftJoin(docPageCodes, eq(docPageCodes.productPageId, productPages.id))
    .where(eq(productPages.id, pageId));
  return row && row.number !== null ? [`${row.projectCode}-D${row.number}`] : [];
}

/** La revisione `drew` più recente della pagina che ha messo il blocco (l'inverso la nomina). */
async function drewRevisionOf(tx: Db, pageId: string, blockId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: productPageRevisions.id })
    .from(productPageRevisions)
    .where(and(eq(productPageRevisions.pageId, pageId), eq(productPageRevisions.kind, "edit"), eq(productPageRevisions.via, "claude"), sql`${productPageRevisions.changes} @> ${JSON.stringify([{ blockId }])}::jsonb`))
    .orderBy(desc(productPageRevisions.lastSeq))
    .limit(1);
  return row?.id ?? null;
}

export const PRODUCT_ENTRIES: CatalogEntry[] = [
  {
    fn: "writeFirstVersion",
    route: "POST /api/projects/:projectId/product/first-version",
    access: docsEdit(fromParam("projectId")),
    request: (args) => ({ params: { projectId: args["projectId"] } }),
    async run(tx, user, args) {
      const projectId = args["projectId"] as string;
      try {
        await startFirstVersion(tx, user, projectId, args["sources"] as FirstVersionSource[]);
      } catch (error) {
        return productRefusal(error);
      }
      return { ok: true, result: { inverse: { fn: "undoFirstVersion", args: { projectId } }, objects: [], codes: [], startsWork: true } };
    },
  },
  {
    fn: "undoFirstVersion",
    route: "POST /api/projects/:projectId/product/first-version/undo",
    access: docsEdit(fromParam("projectId")),
    request: (args) => ({ params: { projectId: args["projectId"] } }),
    async run(tx, user, args) {
      try {
        await undoFirstVersion(tx, user, args["projectId"] as string);
      } catch (error) {
        return productRefusal(error);
      }
      return { ok: true, result: { inverse: null, objects: [], codes: [] } };
    },
  },
  {
    fn: "updateProductPage",
    route: "POST /api/product-pages/:id/update-from-source",
    access: docsEdit(fromProductPage("id")),
    request: (args) => ({ params: { id: args["pageId"] } }),
    async run(tx, user, args) {
      try {
        await requestProductPageUpdate(tx, user, args["pageId"] as string, args["source"] as ProductPageUpdateSource);
      } catch (error) {
        return productRefusal(error);
      }
      return { ok: true, result: { inverse: null, objects: [], codes: await pageCodes(tx, args["pageId"] as string), startsWork: true } };
    },
  },
  {
    fn: "undoProductUpdate",
    route: "POST /api/product-revisions/:id/undo-all",
    access: docsEdit(fromProductRevision("id")),
    request: (args) => ({ params: { id: args["revisionId"] } }),
    async run(tx, user, args) {
      try {
        await undoProductRevision(tx, user, args["revisionId"] as string);
      } catch (error) {
        return productRefusal(error);
      }
      return { ok: true, result: { inverse: null, objects: [], codes: [] } };
    },
  },
  {
    fn: "drawWireframe",
    route: "POST /api/product-pages/:id/wireframes",
    access: docsEdit(fromProductPage("id")),
    request: (args) => ({ params: { id: args["pageId"] } }),
    async run(tx, user, args) {
      const pageId = args["pageId"] as string;
      const at = typeof args["replaceId"] === "string" ? { replaceId: args["replaceId"] } : { afterId: (args["afterId"] as string | null | undefined) ?? null };
      let blockId: string;
      try {
        ({ blockId } = await drawWireframe(tx, user, pageId, at));
      } catch (error) {
        return productRefusal(error);
      }
      const revisionId = await drewRevisionOf(tx, pageId, blockId);
      return {
        ok: true,
        result: { inverse: revisionId === null ? null : { fn: "deleteWireframe", args: { pageId, blockId, revisionId } }, objects: [], codes: await pageCodes(tx, pageId), startsWork: true },
      };
    },
  },
  {
    fn: "deleteWireframe",
    route: "POST /api/product-pages/:id/wireframes/:blockId/undo-draw",
    access: docsEdit(fromProductPage("id")),
    request: (args) => ({ params: { id: args["pageId"], blockId: args["blockId"] } }),
    async run(tx, user, args) {
      try {
        await undoDrawnWireframe(tx, user, args["pageId"] as string, args["blockId"] as string, args["revisionId"] as string);
      } catch (error) {
        return productRefusal(error);
      }
      return { ok: true, result: { inverse: null, objects: [], codes: [] } };
    },
  },
];
