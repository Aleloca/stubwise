import { aiBlockFor } from "../instance/blocks";
import { applyProductSource } from "../productDocs/claude";
import { startFirstVersionAs, undoFirstVersionAs } from "../productDocs/firstVersion";
import { undoProductChangeAs } from "../productDocs/markGestures";
import { productPageById } from "../productDocs/reads";
import { productFactsOf } from "../productDocs/sourceEvents";
import { sourceViewOf } from "../productDocs/sources";
import { drawWireframeAs } from "../productDocs/wireframes";
import { editablePage } from "../productDocs/writes";
import { state } from "../store";
import type { FirstVersionSource, ProductPage, ProductSourceRef } from "../types";
import type { CatalogEntry, CatalogRun } from "./catalog";
import type { ObjectRef } from "./types";

// Le voci della doc di prodotto nel catalogo di Claude (11b, Task 8; spec
// «Claude nel riquadro», decisione 3). Ognuna chiama la scrittura che la
// pagina usa già (`…As`): permessi, rifiuti e cronologia sono quelli della
// doc. Le classi:
// - «scrivi la prima versione» e «disegna questa schermata» sono A con
//   «Undo»: non avvisano nessuno (chi crea segue le pagine);
// - «aggiorna la pagina da questa email o riunione» è B, perché avvisa chi
//   segue la pagina (`dataReasons` in `classes.ts`); dichiarata B, perché
//   con chi chiede unico destinatario la ragione sparirebbe e la classe
//   scenderebbe ad A (P39). Il gesto passa da `applyProductSource` col
//   `manual` di chi chiede: niente coda, e chi chiede non si aspetta da sé;
// - gli inversi sono voci (P39), B perché non si annullano a loro volta.
// Col budget del mese finito nessuna parte (`invalid: monthly_budget`, come
// l'avvio di un'esecuzione): il riquadro lo dice prima con `BudgetBand`, e
// una scheda rimasta aperta non lo scavalca.
// Claude non scrive mai nel registro decisioni (`neverInCatalog.test.ts`).

/** Le funzioni delle voci di questo file. */
export type ProductCatalogFn =
  | "writeFirstVersion"
  | "undoFirstVersion"
  | "updateProductPage"
  | "undoProductUpdate"
  | "drawWireframe"
  | "deleteWireframe";

const invalid = (what: string) => new Error(`invalid: ${what}`);
const notFound = () => new Error("not_found");

/** Il budget del mese finito, detto come il riquadro lo dice per le esecuzioni. */
function withBudget<R>(write: () => R): R {
  try {
    return write();
  } catch (error) {
    if (error instanceof Error && error.message === "ai_blocked") throw invalid("monthly_budget");
    throw error;
  }
}

const onBlocks = (page: ProductPage, blockIds: string[], inverse: CatalogRun["inverse"]): CatalogRun => ({
  codes: [page.code],
  projectIds: [page.projectId],
  inverse,
  objects: [...new Set(blockIds)].map(
    (blockId): ObjectRef => ({ kind: "productBlock", pageId: page.id, blockId }),
  ),
});

/** La revisione di Claude più recente della pagina che ha toccato il blocco. */
const revisionOn = (pageId: string, blockId: string): string | null =>
  state.productRevisions
    .filter((r) => r.pageId === pageId && r.changes.some((c) => c.blockId === blockId))
    .sort((a, b) => b.lastSeq - a.lastSeq)[0]?.id ?? null;

/** La fonte di un aggiornamento chiesto a mano: solo un'email o una riunione. */
function sourceOf(value: unknown): Extract<ProductSourceRef, { id: string }> {
  const s = value as { kind?: unknown; id?: unknown } | null;
  if (!s || (s.kind !== "email" && s.kind !== "meeting") || typeof s.id !== "string") {
    throw invalid("source");
  }
  return { kind: s.kind, id: s.id };
}

/** «Annulla» di una modifica della doc: tutte le sue ancore, con la scrittura della cronologia. */
function undoRevision(me: string, revisionId: unknown): CatalogRun {
  if (typeof revisionId !== "string") throw invalid("revision");
  const revision = state.productRevisions.find((r) => r.id === revisionId);
  const page = revision ? productPageById(revision.pageId) : undefined;
  if (!revision || !page) throw notFound();
  undoProductChangeAs(me, revisionId);
  return onBlocks(page, revision.changes.map((c) => c.blockId), null);
}

export const PRODUCT_ENTRIES: Record<ProductCatalogFn, Omit<CatalogEntry, "fn">> = {
  writeFirstVersion: {
    apiFn: "productDocs.startFirstVersion",
    baseClass: "A",
    undoable: true,
    whoAction: "editDocs",
    run(me, args) {
      const projectId = args.projectId;
      if (typeof projectId !== "string") throw invalid("project");
      if (!Array.isArray(args.sources)) throw invalid("source");
      withBudget(() => startFirstVersionAs(me, projectId, args.sources as FirstVersionSource[]));
      return {
        codes: [],
        projectIds: [projectId],
        inverse: { fn: "undoFirstVersion", args: { projectId } },
        objects: [{ kind: "productSpace", projectId }],
      };
    },
  },
  undoFirstVersion: {
    apiFn: "productDocs.undoFirstVersion",
    baseClass: "B",
    undoable: false,
    whoAction: "editDocs",
    run(me, args) {
      const projectId = args.projectId;
      if (typeof projectId !== "string") throw invalid("project");
      undoFirstVersionAs(me, projectId);
      return { codes: [], projectIds: [projectId], inverse: null, objects: [{ kind: "productSpace", projectId }] };
    },
  },
  updateProductPage: {
    apiFn: "productDocs.updateProductPage",
    baseClass: "B",
    undoable: true,
    whoAction: "editDocs",
    run(me, args) {
      const page = editablePage(me, args.pageId as string);
      const ref = sourceOf(args.source);
      // Una fonte che chi chiede non può aprire si legge come una che non
      // c'è (R-G5): «aggiorna da questa email» vale solo per la propria.
      const view = sourceViewOf(me, ref, page.projectId);
      if (view.gone || view.link === null) throw notFound();
      if (aiBlockFor(page.projectId)?.reason === "monthly_budget") throw invalid("monthly_budget");
      const facts = productFactsOf(ref).filter((f) => f.pageId === page.id);
      if (facts.length === 0) throw invalid("source");
      const out = applyProductSource(ref, page.projectId, facts, { manual: { requesterId: me } });
      const revisionId = out.edits[0] ?? null;
      const revision = state.productRevisions.find((r) => r.id === revisionId);
      // Gli oggetti: i blocchi scritti; senza scrittura (domande, attesa)
      // quelli delle ancore dei fatti, e niente da annullare da qui.
      const blockIds = revision
        ? revision.changes.map((c) => c.blockId)
        : facts.flatMap((f) => (f.anchorId === null ? [] : [f.anchorId]));
      return onBlocks(
        page,
        blockIds,
        revisionId === null ? null : { fn: "undoProductUpdate", args: { revisionId } },
      );
    },
  },
  undoProductUpdate: {
    apiFn: "productDocs.undoProductChange",
    baseClass: "B",
    undoable: false,
    whoAction: "editDocs",
    run(me, args) {
      return undoRevision(me, args.revisionId);
    },
  },
  drawWireframe: {
    apiFn: "productDocs.drawWireframe",
    baseClass: "A",
    undoable: true,
    whoAction: "editDocs",
    run(me, args) {
      const pageId = args.pageId as string;
      const at =
        typeof args.replaceId === "string"
          ? { replaceId: args.replaceId }
          : { afterId: typeof args.afterId === "string" ? args.afterId : null };
      const { blockId } = withBudget(() => drawWireframeAs(me, pageId, at));
      const page = productPageById(pageId)!;
      const revisionId = revisionOn(pageId, blockId);
      return onBlocks(
        page,
        [blockId],
        revisionId === null ? null : { fn: "deleteWireframe", args: { pageId, blockId, revisionId } },
      );
    },
  },
  deleteWireframe: {
    apiFn: "productDocs.undoProductChange",
    baseClass: "B",
    undoable: false,
    whoAction: "editDocs",
    run(me, args) {
      return undoRevision(me, args.revisionId);
    },
  },
};
