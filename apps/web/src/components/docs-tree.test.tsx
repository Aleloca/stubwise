import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { DocTreeNode } from "../lib/docs-api";
import { DocsTree } from "./docs-tree";

/**
 * Test isolato del solo `DocsTree`: i quattro gruppi (technical/functional/
 * manual/releases), l'annidamento per parentId/position e lo stato vuoto. Lo
 * montiamo in un router minimale perché usa `<Link to="/docs/$projectId/$slug">`
 * (serve il contesto della rotta).
 */

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function node(
  overrides: Partial<DocTreeNode> & Pick<DocTreeNode, "id" | "slug" | "title" | "kind">,
): DocTreeNode {
  return {
    parentId: null,
    position: 0,
    sourcePath: null,
    isManual: overrides.kind === "manual",
    createdAt: "2026-06-20T10:00:00.000Z",
    viewCount: 0,
    significant: null,
    ...overrides,
  };
}

function renderTree(nodes: DocTreeNode[], initialPath = "/") {
  const rootRoute = createRootRoute({
    component: () => <DocsTree projectId={PROJECT_ID} nodes={nodes} />,
  });
  // La rotta target dei Link deve esistere nell'albero del router minimale.
  const spaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs/$projectId" });
  const pageRoute = createRoute({ getParentRoute: () => spaceRoute, path: "/$slug" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([spaceRoute.addChildren([pageRoute])]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  render(<RouterProvider router={router} />);
}

describe("DocsTree", () => {
  // La categoria scelta è ricordata per repository: azzeriamo tra i test così
  // ognuno parte dal default (prima categoria disponibile).
  beforeEach(() => localStorage.clear());

  it("rende i quattro gruppi con conteggio e annida i figli sotto il parent", async () => {
    renderTree([
      node({ id: "t1", slug: "tech-overview", title: "Technical overview", kind: "technical" }),
      node({
        id: "t2",
        slug: "module-b",
        title: "Module B",
        kind: "technical",
        parentId: "t1",
        position: 1,
      }),
      node({
        id: "t3",
        slug: "module-a",
        title: "Module A",
        kind: "technical",
        parentId: "t1",
        position: 0,
      }),
      node({ id: "f1", slug: "func", title: "Functional page", kind: "functional" }),
      node({ id: "m1", slug: "manual", title: "Manual page", kind: "manual" }),
      node({ id: "r1", slug: "v1-0", title: "v1.0", kind: "releases" }),
    ]);

    // Gruppi dell'albero con conteggio nel meta. Le release NON sono un gruppo
    // dell'albero: hanno la vista changelog dedicata.
    expect(await screen.findByRole("tab", { name: /Technical 3/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Functional 1/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Manual 1/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Releases/ })).not.toBeInTheDocument();

    // Annidamento: Module A e B sono dentro l'<li> di Technical overview.
    const overviewItem = screen.getByRole("link", { name: "Technical overview" }).closest("li")!;
    const nested = within(overviewItem).getAllByRole("link");
    // [Technical overview, Module A, Module B] — i figli ordinati per position.
    expect(nested.map((l) => l.textContent)).toEqual([
      "Technical overview",
      "Module A",
      "Module B",
    ]);
  });

  it("le pagine releases NON compaiono nell'albero (vista changelog dedicata)", async () => {
    renderTree([
      node({ id: "t1", slug: "tech", title: "Tech", kind: "technical" }),
      node({ id: "r1", slug: "v2-0", title: "v2.0 release notes", kind: "releases" }),
    ]);

    expect(await screen.findByRole("link", { name: "Tech" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "v2.0 release notes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Releases/ })).not.toBeInTheDocument();
  });

  it("ogni voce espone il titolo completo come tooltip nativo", async () => {
    renderTree([
      node({
        id: "t1",
        slug: "tech",
        title: "Un titolo di pagina molto lungo che verrà troncato nella sidebar",
        kind: "technical",
      }),
    ]);

    const link = await screen.findByRole("link", {
      name: "Un titolo di pagina molto lungo che verrà troncato nella sidebar",
    });
    expect(link).toHaveAttribute(
      "title",
      "Un titolo di pagina molto lungo che verrà troncato nella sidebar",
    );
  });

  it("annida tre livelli (root → child → grandchild) via parentId", async () => {
    renderTree([
      node({ id: "l0", slug: "root", title: "Root", kind: "technical" }),
      node({ id: "l1", slug: "child", title: "Child", kind: "technical", parentId: "l0" }),
      node({
        id: "l2",
        slug: "grandchild",
        title: "Grandchild",
        kind: "technical",
        parentId: "l1",
      }),
    ]);

    // Tutti e tre i livelli sono renderizzati come link.
    const root = await screen.findByRole("link", { name: "Root" });
    const child = screen.getByRole("link", { name: "Child" });
    const grandchild = screen.getByRole("link", { name: "Grandchild" });

    // Annidamento DOM effettivo: grandchild dentro child dentro root.
    const rootItem = root.closest("li")!;
    expect(within(rootItem).getByRole("link", { name: "Child" })).toBe(child);
    const childItem = child.closest("li")!;
    expect(within(childItem).getByRole("link", { name: "Grandchild" })).toBe(grandchild);
    // Solo i nodi con figli hanno un toggle di collasso; la foglia no.
    expect(within(rootItem).getByRole("button", { name: /Root/ })).toBeInTheDocument();
    expect(within(childItem).getByRole("button", { name: /Child/ })).toBeInTheDocument();
    const grandchildItem = grandchild.closest("li")!;
    expect(within(grandchildItem).queryByRole("button")).not.toBeInTheDocument();
  });

  it("collassa un padre nascondendone i discendenti e li riespande", async () => {
    renderTree([
      node({ id: "l0", slug: "root", title: "Root", kind: "technical" }),
      node({ id: "l1", slug: "child", title: "Child", kind: "technical", parentId: "l0" }),
      node({
        id: "l2",
        slug: "grandchild",
        title: "Grandchild",
        kind: "technical",
        parentId: "l1",
      }),
    ]);

    // Espanso di default: tutti i discendenti sono visibili.
    expect(await screen.findByRole("link", { name: "Child" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Grandchild" })).toBeInTheDocument();

    // Collasso Root: i discendenti spariscono, Root resta.
    await userEvent.click(screen.getByRole("button", { name: /Root/ }));
    expect(screen.queryByRole("link", { name: "Child" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Grandchild" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Root" })).toBeInTheDocument();

    // Riespando Root: i discendenti ricompaiono.
    await userEvent.click(screen.getByRole("button", { name: /Root/ }));
    expect(screen.getByRole("link", { name: "Child" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Grandchild" })).toBeInTheDocument();
  });

  it('"comprimi tutto" collassa tutti i padri del gruppo, "espandi tutto" li riapre', async () => {
    renderTree([
      node({ id: "l0", slug: "root", title: "Root", kind: "technical" }),
      node({ id: "l1", slug: "child", title: "Child", kind: "technical", parentId: "l0" }),
      node({ id: "s0", slug: "sib", title: "Sibling", kind: "technical", parentId: "l0" }),
    ]);

    expect(await screen.findByRole("link", { name: "Child" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Comprimi tutto|Collapse all/ }));
    expect(screen.queryByRole("link", { name: "Child" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sibling" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Root" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Espandi tutto|Expand all/ }));
    expect(screen.getByRole("link", { name: "Child" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sibling" })).toBeInTheDocument();
  });

  it("categoria senza pagine: nessuna tab per quella categoria", async () => {
    renderTree([node({ id: "t1", slug: "t", title: "Tech", kind: "technical" })]);

    // Solo la tab Technical: le categorie vuote non compaiono affatto.
    expect(await screen.findByRole("tab", { name: /Technical 1/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Manual/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Functional/ })).not.toBeInTheDocument();
  });

  it("mostra una categoria per volta e cambia contenuto al click sulla tab", async () => {
    renderTree([
      node({ id: "t1", slug: "tech", title: "Tech page", kind: "technical" }),
      node({ id: "f1", slug: "func", title: "Func page", kind: "functional" }),
    ]);

    // All'ingresso senza pagina attiva: prima categoria disponibile (technical).
    expect(await screen.findByRole("link", { name: "Tech page" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Func page" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /Functional 1/ }));
    expect(screen.getByRole("link", { name: "Func page" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Tech page" })).not.toBeInTheDocument();
  });

  it("la tab attiva segue il kind della pagina aperta", async () => {
    renderTree(
      [
        node({ id: "t1", slug: "tech", title: "Tech page", kind: "technical" }),
        node({ id: "p1", slug: "prod", title: "Product page", kind: "product" }),
      ],
      "/docs/" + PROJECT_ID + "/prod",
    );

    // Entrando su una pagina product, l'albero mostra la categoria Product.
    expect(await screen.findByRole("link", { name: "Product page" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Tech page" })).not.toBeInTheDocument();
  });

  it("mostra il download ZIP della categoria attiva, con l'href corretto", async () => {
    renderTree([
      node({ id: "t1", slug: "tech", title: "Tech", kind: "technical" }),
      node({ id: "f1", slug: "func", title: "Func", kind: "functional" }),
    ]);

    const techDownload = await screen.findByRole("link", { name: /Technical/i });
    expect(techDownload).toHaveAttribute(
      "href",
      `/api/repositories/${PROJECT_ID}/docs/export?kind=technical`,
    );
    expect(techDownload).toHaveAttribute("download");

    // Cambiando categoria il download segue la tab attiva.
    await userEvent.click(screen.getByRole("tab", { name: /Functional 1/ }));
    expect(screen.getByRole("link", { name: /Functional/i })).toHaveAttribute(
      "href",
      `/api/repositories/${PROJECT_ID}/docs/export?kind=functional`,
    );
  });

  it("non mostra il bottone di download per le categorie vuote", async () => {
    renderTree([node({ id: "t1", slug: "tech", title: "Tech", kind: "technical" })]);

    await screen.findByRole("tab", { name: /Technical 1/ });
    // Manual/Functional/Releases sono vuoti: nessuna tab, quindi nessun export.
    expect(
      screen.queryByRole("link", { name: /Manual.*\.md.*zip|Manual.*zip/i }),
    ).not.toBeInTheDocument();
    // Un solo link di download in totale (la categoria attiva).
    const downloads = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href")?.includes("/docs/export"));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toHaveAttribute("href", expect.stringContaining("kind=technical"));
  });

});
