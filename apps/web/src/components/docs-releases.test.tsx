import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { DocTreeNode } from "../lib/docs-api";
import { DocsReleases } from "./docs-releases";

/**
 * Test della vista changelog: data leggibile, badge "minore" solo sulle release
 * non significative, filtro "solo significative" e ricerca testuale. Il corpo
 * markdown è caricato on-demand (query per slug): qui non lo espandiamo, quindi
 * il QueryClient serve solo a soddisfare il contesto.
 */

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function release(
  overrides: Partial<DocTreeNode> & Pick<DocTreeNode, "id" | "slug" | "title">,
): DocTreeNode {
  return {
    kind: "releases",
    parentId: null,
    position: 0,
    sourcePath: null,
    isManual: false,
    createdAt: "2026-07-24T10:00:00.000Z",
    viewCount: 0,
    significant: true,
    ...overrides,
  };
}

const RELEASES: DocTreeNode[] = [
  release({
    id: "r1",
    slug: "release-20260724-1000-abc1234",
    title: "Nuova capability di ricerca",
    position: -100,
  }),
  release({
    id: "r2",
    slug: "release-20260720-0900-def5678",
    title: "Refactor interno del worker",
    position: -50,
    significant: false,
    createdAt: "2026-07-20T09:00:00.000Z",
  }),
];

function renderReleases(releases: DocTreeNode[] = RELEASES) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <DocsReleases projectId={PROJECT_ID} releases={releases} />
      </QueryClientProvider>
    ),
  });
  const spaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs/$projectId" });
  const pageRoute = createRoute({ getParentRoute: () => spaceRoute, path: "/$slug" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([spaceRoute.addChildren([pageRoute])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

describe("DocsReleases", () => {
  it("elenca le release con data e commit, badge minore solo sulle non significative", async () => {
    renderReleases();

    expect(await screen.findByText("Nuova capability di ricerca")).toBeInTheDocument();
    expect(screen.getByText("Refactor interno del worker")).toBeInTheDocument();

    // Data assoluta leggibile della entry (non lo slug grezzo).
    expect(screen.getByText("24/07/2026")).toBeInTheDocument();
    // Commit short derivato dallo slug release-YYYYMMDD-HHmm-<sha>.
    expect(screen.getByText(/abc1234/)).toBeInTheDocument();

    // Badge "minore": una sola volta, sulla release non significativa.
    const minor = screen.getAllByText(/minor/i);
    expect(minor).toHaveLength(1);
  });

  it("il filtro 'solo significative' nasconde le release minori", async () => {
    const user = userEvent.setup();
    renderReleases();

    await user.click(await screen.findByRole("checkbox", { name: /significant/i }));

    expect(screen.getByText("Nuova capability di ricerca")).toBeInTheDocument();
    expect(screen.queryByText("Refactor interno del worker")).not.toBeInTheDocument();
  });

  it("la ricerca testuale filtra per titolo", async () => {
    const user = userEvent.setup();
    renderReleases();

    await user.type(await screen.findByRole("searchbox"), "refactor");

    expect(screen.getByText("Refactor interno del worker")).toBeInTheDocument();
    expect(screen.queryByText("Nuova capability di ricerca")).not.toBeInTheDocument();
  });

  it("nessuna release: stato vuoto", async () => {
    renderReleases([]);
    expect(await screen.findByText(/no releases yet/i)).toBeInTheDocument();
  });
});
