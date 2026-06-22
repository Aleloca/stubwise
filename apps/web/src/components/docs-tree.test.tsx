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
 * Test isolato del solo `DocsTree`: i tre gruppi, l'annidamento per
 * parentId/position e lo stato vuoto. Lo montiamo in un router minimale perché
 * usa `<Link to="/docs/$projectId/$slug">` (serve il contesto della rotta).
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
  it("rende i tre gruppi con conteggio e annida i figli sotto il parent", async () => {
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
    ]);

    // Tre gruppi con conteggio nel meta.
    expect(await screen.findByRole("button", { name: /Technical 3/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Functional 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Manual 1/ })).toBeInTheDocument();

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

  it("gruppo vuoto: mostra il placeholder vuoto", async () => {
    renderTree([node({ id: "t1", slug: "t", title: "Tech", kind: "technical" })]);

    // Manuale è vuoto: chiuso di default, lo si apre per vedere il placeholder.
    const manual = await screen.findByRole("button", { name: /Manual 0/ });
    await userEvent.click(manual);
    expect(screen.getByText("// empty")).toBeInTheDocument();
  });
});
