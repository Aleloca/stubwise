import type { DocPageRef, DocTreeNode } from "../data/model";

/** Lo slug di una pagina dal suo titolo: minuscole, senza accenti, parole unite da «-». */
export function slugify(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Uno slug scritto a mano è valido: minuscole, cifre e «-», senza «-» ai bordi. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Gli slug che nello spazio sono già viste (`…/<repo>/new`, `brief`,
 * `releases`, `graph`): una pagina con uno di questi non si aprirebbe mai.
 * Il livello dati li rifiuta (`slug_conflict`), il form lo dice prima.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["new", "brief", "releases", "graph"]);

/**
 * L'albero di una categoria: ogni segmento del percorso («Guide / Dialer») è
 * una cartella, la pagina è la foglia. Cartelle prima delle pagine, entrambe
 * per nome.
 */
export function buildDocTree(pages: readonly DocPageRef[]): DocTreeNode[] {
  const root: DocTreeNode = { name: "", page: null, children: [] };
  for (const page of pages) {
    let node = root;
    for (const segment of page.path
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean)) {
      let folder = node.children.find((c) => c.page === null && c.name === segment);
      if (!folder) {
        folder = { name: segment, page: null, children: [] };
        node.children.push(folder);
      }
      node = folder;
    }
    node.children.push({ name: page.title, page, children: [] });
  }
  sortTree(root.children);
  return root.children;
}

function sortTree(nodes: DocTreeNode[]): void {
  nodes.sort(
    (a, b) => Number(a.page !== null) - Number(b.page !== null) || a.name.localeCompare(b.name),
  );
  for (const n of nodes) sortTree(n.children);
}
