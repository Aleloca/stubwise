import { excerptOfBlocks } from "../../domain/productDocs/blocks";
import { buildProductTree } from "../../domain/productDocs/tree";
import { docsAccess } from "../docs/reads";
import { PEOPLE } from "../seed/people";
import { copy, gate, state, visibleProjectIds } from "../store";
import type {
  ProductPage,
  ProductPageRef,
  ProductPageView,
  ProductSpaceView,
} from "../types";
import { can, viewerFor } from "../viewer";

// Le letture dello spazio Prodotto (area 11a). Chi vede che cosa lo decide
// `docsAccess`, la stessa funzione dei Docs: un progetto invisibile,
// inesistente o col modulo Docs spento risponde come uno che non esiste
// (`null`, elenchi vuoti); un progetto visibile senza `docs.view` risponde
// `forbidden`. Nelle letture trasversali (`readableProductPages`) le pagine
// che chi guarda non legge semplicemente non ci sono (R-G5).

const forbidden = () => new Error("forbidden");

export const productPageById = (id: string): ProductPage | undefined =>
  state.productPages.find((p) => p.id === id);

export const productPageByCode = (code: string): ProductPage | undefined =>
  state.productPages.find((p) => p.code === code);

/** Le pagine di prodotto che chi guarda legge, in ogni progetto (`docsAccess === "read"`). */
export const readableProductPages = (me: string): ProductPage[] =>
  state.productPages.filter((p) => docsAccess(me, p.projectId) === "read");

export function productPageRef(page: ProductPage): ProductPageRef {
  return {
    id: page.id,
    code: page.code,
    projectId: page.projectId,
    parentId: page.parentId,
    order: page.order,
    title: page.title,
    excerpt: excerptOfBlocks(page.blocks),
    updatedAt: page.updatedAt,
    updatedById: page.updatedById,
  };
}

export const productPagesOf = (projectId: string): ProductPage[] =>
  state.productPages.filter((p) => p.projectId === projectId);

/** Le sottopagine dirette, nel loro ordine. */
export const childrenOf = (projectId: string, parentId: string | null): ProductPage[] =>
  productPagesOf(projectId)
    .filter((p) => p.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code, "en", { numeric: true }));

/** Le pagine più recenti prima; a pari data il codice più alto (la più nuova). */
const byRecent = (a: ProductPage, b: ProductPage) =>
  b.updatedAt.localeCompare(a.updatedAt) || b.code.localeCompare(a.code, "en", { numeric: true });

/** Lo spazio Prodotto di un progetto; `null` dove non esiste per chi guarda, `forbidden` senza `docs.view`. */
export async function getProductSpace(projectId: string): Promise<ProductSpaceView | null> {
  const me = await gate("productDocs.getProductSpace");
  const access = docsAccess(me, projectId);
  if (access === "forbidden") throw forbidden();
  if (access === "none") return null;
  const project = state.projectsById.get(projectId)!;
  const pages = productPagesOf(projectId);
  return {
    projectId,
    projectCode: project.code,
    tree: buildProductTree(pages.map(productPageRef)),
    pageCount: pages.length,
    recent: [...pages].sort(byRecent).slice(0, 5).map(productPageRef),
    permissions: { edit: can(viewerFor(me), "docs.edit", projectId) },
  };
}

/** Il progetto di un codice `<P>-D<n>`, dal suo prefisso. */
const projectOfCode = (code: string) => {
  const at = code.lastIndexOf("-D");
  const prefix = at > 0 ? code.slice(0, at) : null;
  return prefix === null ? undefined : state.projects.find((p) => p.code === prefix);
};

/** Una decisione del registro come la legge chi guarda; `null` se il suo progetto non lo vede. */
function decisionFor(me: string, decisionId: string): ProductPageView["decisions"][string] {
  const d = state.decisionLog.find((x) => x.id === decisionId);
  if (!d || !visibleProjectIds(me).has(d.projectId)) return null;
  const by = d.decidedById === null ? null : (PEOPLE.find((p) => p.id === d.decidedById) ?? null);
  return { title: d.title, decidedAt: d.decidedAt, decidedByName: by?.name ?? null };
}

/**
 * Una pagina per codice; `null` se non c'è (o non c'è per chi guarda). In un
 * progetto visibile senza `docs.view` è `forbidden` anche un codice che non
 * esiste: la risposta non dice se la pagina c'è.
 */
export async function getProductPage(code: string): Promise<ProductPageView | null> {
  const me = await gate("productDocs.getProductPage");
  const project = projectOfCode(code);
  if (project && docsAccess(me, project.id) === "forbidden") throw forbidden();
  const page = productPageByCode(code);
  if (!page || docsAccess(me, page.projectId) !== "read") return null;
  const edit = can(viewerFor(me), "docs.edit", page.projectId);
  const hasChildren = childrenOf(page.projectId, page.id).length > 0;
  const breadcrumbs: ProductPageRef[] = [];
  const seen = new Set<string>([page.id]);
  for (let at = page.parentId; at !== null && !seen.has(at); ) {
    seen.add(at);
    const parent = productPageById(at);
    if (!parent) break;
    breadcrumbs.unshift(productPageRef(parent));
    at = parent.parentId;
  }
  const decisions: ProductPageView["decisions"] = {};
  for (const block of page.blocks)
    if (block.type === "decision") decisions[block.decisionId] = decisionFor(me, block.decisionId);
  return {
    ...copy(page),
    breadcrumbs,
    permissions: {
      edit,
      delete: edit && !hasChildren,
      // La regola vale solo per chi potrebbe eliminare: senza `docs.edit` il
      // bottone è spento per il permesso (con «Who?»), non per le sottopagine.
      deleteBlocked: edit && hasChildren ? "has_children" : null,
    },
    following: state.productFollows.some((f) => f.pageId === page.id && f.personId === me),
    decisions,
    // I fili aperti: le radici non risolte, con l'ancora viva o no.
    openComments: state.productComments.filter(
      (c) => c.pageId === page.id && c.replyToId === null && c.resolved === null,
    ).length,
  };
}
