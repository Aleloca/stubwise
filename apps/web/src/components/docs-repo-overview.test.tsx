import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProjectBrief } from "@stubwise/shared";
import type { DocHighlights, DocTreeNode } from "../lib/docs-api";
import { DocsRepoOverview } from "./docs-repo-overview";

/**
 * Test dell'overview di repo: è un componente presentazionale puro (dati passati
 * come props dal wrapper di rotta), quindi basta un router minimale per i Link.
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

const TREE: DocTreeNode[] = [
  node({ id: "t1", slug: "architecture-overview", title: "Architecture overview", kind: "technical" }),
  node({ id: "t2", slug: "auth-module", title: "Auth module", kind: "technical", position: 1 }),
  node({ id: "p1", slug: "getting-started", title: "Getting started", kind: "product" }),
  node({
    id: "r1",
    slug: "release-20260724-1000-abc1234",
    title: "Ultima release",
    kind: "releases",
    position: -100,
  }),
];

const HIGHLIGHTS: DocHighlights = {
  countsByKind: { technical: 2, functional: 0, product: 1, manual: 0, releases: 1 },
  topViewed: [
    { slug: "auth-module", title: "Auth module", kind: "technical", viewCount: 42 },
  ],
  recentlyUpdated: [
    { slug: "getting-started", title: "Getting started", kind: "product", viewCount: 3 },
  ],
  latestReleases: [
    {
      slug: "release-20260724-1000-abc1234",
      title: "Ultima release",
      createdAt: "2026-07-24T10:00:00.000Z",
      significant: true,
      commitSha: null,
    },
  ],
};

const BRIEF: ProjectBrief = {
  identity: "Stubwise è un sistema di ticketing self-hostable con pipeline AI.",
  actors: [],
  surfaces: [],
  glossary: [],
  invariants: [],
  confidentialFacts: [],
  journeys: [],
  existingSources: [],
};

function renderOverview(props: Partial<Parameters<typeof DocsRepoOverview>[0]> = {}) {
  const rootRoute = createRootRoute({
    component: () => (
      <DocsRepoOverview
        projectId={PROJECT_ID}
        repoName="stubwise"
        tree={TREE}
        highlights={HIGHLIGHTS}
        brief={BRIEF}
        {...props}
      />
    ),
  });
  const spaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs/$projectId" });
  const pageRoute = createRoute({ getParentRoute: () => spaceRoute, path: "/$slug" });
  const briefRoute = createRoute({ getParentRoute: () => spaceRoute, path: "/brief" });
  const releasesRoute = createRoute({ getParentRoute: () => spaceRoute, path: "/releases" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      spaceRoute.addChildren([pageRoute, briefRoute, releasesRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

describe("DocsRepoOverview", () => {
  it("mostra nome del repo e sintesi dal brief", async () => {
    renderOverview();

    expect(await screen.findByRole("heading", { name: "stubwise" })).toBeInTheDocument();
    expect(
      screen.getByText(/sistema di ticketing self-hostable/i),
    ).toBeInTheDocument();
  });

  it("card categoria con conteggio, che linkano alla prima pagina della categoria", async () => {
    renderOverview();

    const categories = await screen.findByRole("region", { name: /categories/i });
    const technical = within(categories).getByRole("link", { name: /Technical/i });
    expect(technical).toHaveAttribute("href", `/docs/${PROJECT_ID}/architecture-overview`);
    expect(within(technical).getByText("2")).toBeInTheDocument();

    // Le categorie senza pagine non compaiono.
    expect(within(categories).queryByRole("link", { name: /Functional/i })).not.toBeInTheDocument();
  });

  it("sezione 'inizia da qui' con brief e prima pagina tecnica", async () => {
    renderOverview();

    const start = await screen.findByRole("region", { name: /start here/i });
    expect(within(start).getByRole("link", { name: /brief/i })).toHaveAttribute(
      "href",
      `/docs/${PROJECT_ID}/brief`,
    );
    expect(within(start).getByRole("link", { name: /Architecture overview/ })).toHaveAttribute(
      "href",
      `/docs/${PROJECT_ID}/architecture-overview`,
    );
  });

  it("sezione 'novità' con ultime release, aggiornamenti e pagine più lette", async () => {
    renderOverview();

    const news = await screen.findByRole("region", { name: /what.s new/i });
    // Release con data e link alla vista changelog.
    expect(within(news).getByText("Ultima release")).toBeInTheDocument();
    expect(within(news).getByText("24/07/2026")).toBeInTheDocument();
    // Pagina più letta col suo contatore.
    expect(within(news).getByRole("link", { name: /Auth module/ })).toHaveAttribute(
      "href",
      `/docs/${PROJECT_ID}/auth-module`,
    );
  });

  it("senza brief: nessuna sintesi, il resto resta", async () => {
    renderOverview({ brief: null });

    expect(await screen.findByRole("heading", { name: "stubwise" })).toBeInTheDocument();
    expect(screen.queryByText(/sistema di ticketing self-hostable/i)).not.toBeInTheDocument();
    const categories = screen.getByRole("region", { name: /categories/i });
    expect(within(categories).getByRole("link", { name: /Technical/i })).toBeInTheDocument();
  });
});
