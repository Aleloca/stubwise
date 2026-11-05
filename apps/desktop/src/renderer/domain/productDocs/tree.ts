import type { ProductPageRef, ProductTreeNode } from "../../data/model";

/** L'albero dello spazio Prodotto: pagine annidate senza limite di profondità. */

const byOrderThenCode = (a: ProductPageRef, b: ProductPageRef) =>
  a.order - b.order || a.code.localeCompare(b.code, "en", { numeric: true });

/**
 * L'albero delle pagine: i fratelli per `order`, poi per codice (D9 prima di
 * D10). Una pagina il cui genitore non c'è sta fra le radici, così non
 * sparisce dall'albero.
 */
export function buildProductTree(pages: readonly ProductPageRef[]): ProductTreeNode[] {
  const ids = new Set(pages.map((p) => p.id));
  const children = new Map<string | null, ProductPageRef[]>();
  for (const page of pages) {
    const parent = page.parentId !== null && ids.has(page.parentId) ? page.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), page]);
  }
  const build = (parent: string | null): ProductTreeNode[] =>
    [...(children.get(parent) ?? [])].sort(byOrderThenCode).map((page) => ({ page, children: build(page.id) }));
  return build(null);
}

/** L'albero in fila, in profondità, con la profondità di ogni pagina (0 = radice). */
export function flattenTree(nodes: readonly ProductTreeNode[]): { page: ProductPageRef; depth: number }[] {
  const out: { page: ProductPageRef; depth: number }[] = [];
  const walk = (list: readonly ProductTreeNode[], depth: number) => {
    for (const node of list) {
      out.push({ page: node.page, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

/**
 * La pagina può andare sotto `parentId` (`null` = radice): no sotto sé
 * stessa né sotto un suo discendente, no per pagine che non ci sono.
 */
export function canMoveUnder(pages: readonly ProductPageRef[], pageId: string, parentId: string | null): boolean {
  const byId = new Map(pages.map((p) => [p.id, p]));
  if (!byId.has(pageId)) return false;
  if (parentId === null) return true;
  if (!byId.has(parentId)) return false;
  // Risale dal genitore proposto: se incontra la pagina, è un suo discendente
  // (`seen` ferma un giro nei dati, che non dovrebbe esistere).
  const seen = new Set<string>();
  let at: string | null = parentId;
  while (at !== null && !seen.has(at)) {
    if (at === pageId) return false;
    seen.add(at);
    at = byId.get(at)?.parentId ?? null;
  }
  return true;
}
