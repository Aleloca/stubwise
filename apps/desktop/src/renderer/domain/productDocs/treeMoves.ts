import type { ProductPageRef, ProductTreeNode } from "../../data/model";
import { buildProductTree } from "./tree";

// Gli spostamenti dell'albero Prodotto, puri (area 11a, Task 7): dove cade una
// pagina trascinata, la posizione ottimistica prima della risposta e la frase
// che annuncia dove è finita. La regola (cicli, permessi) resta del livello
// dati: qui si calcola solo il disegno.

/** Un livello del trascinamento orizzontale. */
export const LEVEL_PX = 24;

/** Una riga visibile dell'albero: la pagina, il suo livello (0 = radice), se ha figli. */
export interface FlatRow {
  page: ProductPageRef;
  depth: number;
  hasChildren: boolean;
}

export function findNode(nodes: readonly ProductTreeNode[], id: string): ProductTreeNode | null {
  for (const node of nodes) {
    if (node.page.id === id) return node;
    const below = findNode(node.children, id);
    if (below) return below;
  }
  return null;
}

/** Le sottopagine di `parentId` (`null` = le radici), nell'ordine dell'albero. */
export function siblingsOf(nodes: readonly ProductTreeNode[], parentId: string | null): ProductTreeNode[] {
  if (parentId === null) return [...nodes];
  return findNode(nodes, parentId)?.children ?? [];
}

/** Gli antenati di una pagina, dal genitore alla radice. */
export function ancestorsOf(pages: readonly ProductPageRef[], pageId: string): string[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let at = byId.get(pageId)?.parentId ?? null; at !== null && !seen.has(at); ) {
    seen.add(at);
    out.push(at);
    at = byId.get(at)?.parentId ?? null;
  }
  return out;
}

/**
 * Le pagine con una pagina spostata sotto `parentId` al posto `index` (fra i
 * fratelli senza di lei; oltre la fine va in fondo), e i fratelli di partenza
 * rinumerati.
 */
export function movedPages(
  pages: readonly ProductPageRef[],
  pageId: string,
  parentId: string | null,
  index: number,
): ProductPageRef[] {
  const page = pages.find((p) => p.id === pageId);
  if (!page) return [...pages];
  const tree = buildProductTree(pages);
  const order = new Map<string, number>();
  siblingsOf(tree, page.parentId)
    .filter((n) => n.page.id !== pageId)
    .forEach((n, i) => order.set(n.page.id, i));
  const after = siblingsOf(tree, parentId)
    .filter((n) => n.page.id !== pageId)
    .map((n) => n.page.id);
  after.splice(Math.min(index, after.length), 0, pageId);
  after.forEach((id, i) => order.set(id, i));
  return pages.map((p) => ({
    ...p,
    parentId: p.id === pageId ? parentId : p.parentId,
    order: order.get(p.id) ?? p.order,
  }));
}

function arrayMove<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/**
 * Dove andrebbe la pagina trascinata (`activeId`) lasciata sopra `overId`
 * con `offsetX` di spostamento orizzontale: il livello viene da lì (24 px =
 * un livello), stretto fra quello della riga sotto e quello della riga sopra
 * più uno; da livello e righe vicine il genitore, e il posto fra i fratelli.
 */
export function projectDrop(
  items: readonly FlatRow[],
  activeId: string,
  overId: string,
  offsetX: number,
): { parentId: string | null; depth: number; index: number } | null {
  const activeIndex = items.findIndex((i) => i.page.id === activeId);
  const overIndex = items.findIndex((i) => i.page.id === overId);
  if (activeIndex < 0 || overIndex < 0) return null;
  const moved = arrayMove(items, activeIndex, overIndex);
  const active = moved[overIndex]!;
  const prev = moved[overIndex - 1];
  const next = moved[overIndex + 1];
  const max = prev ? prev.depth + 1 : 0;
  const min = next ? next.depth : 0;
  const depth = Math.max(min, Math.min(max, active.depth + Math.round(offsetX / LEVEL_PX)));
  let parentId: string | null = null;
  if (depth > 0 && prev) {
    if (depth === prev.depth) parentId = prev.page.parentId;
    else if (depth > prev.depth) parentId = prev.page.id;
    else
      parentId =
        moved
          .slice(0, overIndex)
          .reverse()
          .find((i) => i.depth === depth)?.page.parentId ?? null;
  }
  const index = moved.slice(0, overIndex).filter((i) => i.page.parentId === parentId).length;
  return { parentId, depth, index };
}

/**
 * Dove sta una pagina, da dire dopo uno spostamento: prima della successiva,
 * dopo la precedente, dentro il genitore; sola alla radice, nessun nome.
 */
export function moveAnnouncement(
  pages: readonly ProductPageRef[],
  pageId: string,
): { kind: "before" | "after" | "inside" | "alone"; other: string | null } {
  const page = pages.find((p) => p.id === pageId);
  if (!page) return { kind: "alone", other: null };
  const sibs = siblingsOf(buildProductTree(pages), page.parentId).map((n) => n.page);
  const at = sibs.findIndex((p) => p.id === pageId);
  if (sibs[at + 1]) return { kind: "before", other: sibs[at + 1]!.title };
  if (sibs[at - 1]) return { kind: "after", other: sibs[at - 1]!.title };
  const parent = page.parentId ? pages.find((p) => p.id === page.parentId) : undefined;
  if (parent) return { kind: "inside", other: parent.title };
  return { kind: "alone", other: null };
}
