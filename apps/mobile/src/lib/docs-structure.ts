import type { DocPageKind, DocSpace, DocTreeNode, Reader, SearchDocHit, SearchDocSemanticHit } from "@stubwise/shared";

/**
 * LA STRUTTURA DELLA DOCUMENTAZIONE nell'app, come sul web («la
 * documentazione nell'app, come sul web», 25 set 2026): funzioni PURE,
 * gemelle deliberate di quelle del web — `buildForest`
 * (`apps/web/src/components/docs-tree.tsx`), `releaseCommitFromSlug`
 * (`docs-releases.tsx`) e `mergeDocs` (`global-search-palette.tsx`). Due copie
 * per due superfici, come `pulse-line.ts`: se una cambia, cambia l'altra.
 */

/** Un nodo dell'albero con i suoi figli. */
export type DocForestNode = Reader<DocTreeNode> & { children: DocForestNode[] };

/**
 * Da una lista piatta (i nodi portano `parentId`) a una foresta, ordinata a
 * ogni livello per `position` e poi per titolo — come `buildForest` del web.
 * Un nodo il cui padre non è nella lista (sta in un'altra categoria) sale alla
 * radice: sparire sarebbe peggio.
 */
export function buildDocForest(nodes: readonly Reader<DocTreeNode>[]): DocForestNode[] {
  const byId = new Map<string, DocForestNode>();
  for (const node of nodes) byId.set(node.id, { ...node, children: [] });

  const roots: DocForestNode[] = [];
  for (const item of byId.values()) {
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    if (parent) parent.children.push(item);
    else roots.push(item);
  }

  const sort = (items: DocForestNode[]): DocForestNode[] => {
    items.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    for (const item of items) sort(item.children);
    return items;
  };
  return sort(roots);
}

/** Le tab della pagina di un repository. */
export type RepoDocsTab = "overview" | DocPageKind;

/** L'ordine fisso delle categorie, dopo Overview. */
const CATEGORY_ORDER: readonly DocPageKind[] = ["technical", "functional", "product", "manual", "releases"];

/**
 * Le tab di un repository: Overview SEMPRE, poi le sole categorie che hanno
 * almeno una pagina, nell'ordine fisso. Un kind che questa versione dell'app
 * non conosce (`UNKNOWN`, da `readerSchema`) non apre una tab: non saprebbe
 * che nome darle.
 */
export function repoDocTabs(nodes: readonly Reader<DocTreeNode>[]): RepoDocsTab[] {
  const present = new Set<string>(nodes.map((node) => node.kind));
  return ["overview", ...CATEGORY_ORDER.filter((kind) => present.has(kind))];
}

/**
 * Il commit breve dallo slug `release-YYYYMMDD-HHmm-<sha>`: le release sono
 * pagine persistenti senza generazione, quindi il loro `commitSha` è sempre
 * null e il commit vive solo nello slug. Null per le release di forma diversa.
 */
export function releaseCommitFromSlug(slug: string): string | null {
  const match = /^release-\d{8}-\d{4}-([0-9a-f]+)$/.exec(slug);
  return match ? match[1]! : null;
}

/** Un risultato di ricerca nei Docs, dall'una o dall'altra corsia. */
export type DocSearchHit = Reader<SearchDocHit> | Reader<SearchDocSemanticHit>;

/**
 * Fonde la ricerca full-text con quella semantica: dedup per `(repositoryId,
 * slug)`, i semantici PRIMA (più rilevanti), poi i full-text non già presenti
 * — come `mergeDocs` del web.
 */
export function mergeDocSearchHits(
  fullText: readonly Reader<SearchDocHit>[],
  semantic: readonly Reader<SearchDocSemanticHit>[],
): DocSearchHit[] {
  const seen = new Set<string>();
  const out: DocSearchHit[] = [];
  for (const hit of [...semantic, ...fullText]) {
    const key = `${hit.repositoryId}:${hit.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/**
 * Il repository «principale» di un progetto: quello con più pagine — la
 * stessa euristica di `mainSpace` nella home Docs di progetto del web. È il
 * repository da cui la pagina generale prende il brief e «Start here».
 */
export function mainDocSpace(spaces: readonly Reader<DocSpace>[]): Reader<DocSpace> | undefined {
  return [...spaces].sort((a, b) => b.pageCount - a.pageCount)[0];
}
