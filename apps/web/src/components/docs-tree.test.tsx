import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
    ...overrides,
  };
}

function renderTree(nodes: DocTreeNode[]) {
  const rootRoute = createRootRoute({
    component: () => <DocsTree projectId={PROJECT_ID} nodes={nodes} />,
  });
  // La rotta target dei Link deve esistere nell'albero del router minimale.
  const spaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs/$projectId" });
  const pageRoute = createRoute({ getParentRoute: () => spaceRoute, path: "/$slug" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([spaceRoute.addChildren([pageRoute])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

describe("DocsTree", () => {
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

    // Quattro gruppi con conteggio nel meta.
    expect(await screen.findByRole("button", { name: /Technical 3/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Functional 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Manual 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Releases 1/ })).toBeInTheDocument();

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

  it("una pagina releases compare nel gruppo Releases", async () => {
    renderTree([
      node({ id: "t1", slug: "tech", title: "Tech", kind: "technical" }),
      node({ id: "r1", slug: "v2-0", title: "v2.0 release notes", kind: "releases" }),
    ]);

    // Il gruppo Releases ha conteggio 1 ed è aperto di default (non vuoto): la
    // pagina è visibile come link dentro la sua sezione.
    const releasesGroup = await screen.findByRole("button", { name: /Releases 1/ });
    expect(releasesGroup).toBeInTheDocument();
    const releasePage = screen.getByRole("link", { name: "v2.0 release notes" });
    expect(releasePage).toBeInTheDocument();
    expect(releasePage).toHaveAttribute(
      "href",
      `/docs/${PROJECT_ID}/v2-0`,
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

  it("gruppo vuoto: mostra il placeholder vuoto", async () => {
    renderTree([node({ id: "t1", slug: "t", title: "Tech", kind: "technical" })]);

    // Manuale è vuoto: chiuso di default, lo si apre per vedere il placeholder.
    const manual = await screen.findByRole("button", { name: /Manual 0/ });
    await userEvent.click(manual);
    expect(screen.getByText("// empty")).toBeInTheDocument();
  });
});
