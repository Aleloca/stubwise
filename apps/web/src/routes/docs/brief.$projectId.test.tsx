import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import type { DocBriefResponse, ProjectBrief } from "../../lib/docs-api";
import { DocsBriefView } from "./brief.$projectId";

// Test isolato della tab "Brief": render con un brief mock completo (tutte le
// sezioni, incluso il blocco fatti riservati con la nota) e lo stato 404
// (nessun brief → messaggio "rigenera la documentazione"). `getDocBrief` è
// mockato; il componente è montato in un router minimale che riproduce l'id di
// rotta `/authed/docs/$projectId/brief` da cui legge i params.

const { getDocBrief } = vi.hoisted(() => ({ getDocBrief: vi.fn() }));
vi.mock("../../lib/docs-api", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/docs-api")>();
  return { ...actual, getDocBrief };
});

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const FULL_BRIEF: ProjectBrief = {
  identity: "A ticketing product for support teams.",
  actors: [
    { name: "Support agent", description: "handles tickets", internal: true },
    { name: "Customer", description: "opens tickets", internal: false },
  ],
  surfaces: [
    { name: "Web app", type: "webapp", rootPath: "apps/web", audience: "customers", internal: false },
    { name: "Admin", type: "backoffice", rootPath: "apps/admin", audience: "staff", internal: true },
  ],
  glossary: [{ term: "Ticket", definition: "a unit of support work" }],
  invariants: ["A ticket always has an owner"],
  confidentialFacts: [
    {
      fact: "18% markup on tokens",
      reason: "pricing strategy",
      source: "billing.ts",
      avoid: "never state a percentage margin",
    },
  ],
  journeys: [{ actor: "Customer", title: "Open a ticket", summary: "fill the form and submit" }],
  existingSources: ["README.md"],
};

/** Risposta completa della route brief (brief + metadati generazione + esclusioni). */
function response(overrides: Partial<DocBriefResponse> = {}): DocBriefResponse {
  return {
    brief: FULL_BRIEF,
    generation: { createdAt: "2026-07-07T10:00:00.000Z", commitSha: "abcdef1234567890" },
    productExclusions: [],
    ...overrides,
  };
}

function renderBrief() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({ getParentRoute: () => rootRoute, id: "authed" });
  const spaceRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/docs/$projectId",
  });
  const briefRoute = createRoute({
    getParentRoute: () => spaceRoute,
    path: "/brief",
    component: DocsBriefView,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([spaceRoute.addChildren([briefRoute])]),
    ]),
    history: createMemoryHistory({ initialEntries: [`/docs/${PROJECT_ID}/brief`] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  getDocBrief.mockReset();
});

describe("DocsBriefView", () => {
  it("rende tutte le sezioni del brief, incluso il blocco fatti riservati con la nota", async () => {
    getDocBrief.mockResolvedValue(response());
    renderBrief();

    // Identità + sezioni principali.
    expect(await screen.findByText("A ticketing product for support teams.")).toBeInTheDocument();
    expect(screen.getByText("Support agent")).toBeInTheDocument();
    expect(screen.getByText("Customer")).toBeInTheDocument();
    // Badge interno/esterno presenti (attori + superfici).
    expect(screen.getAllByText("internal").length).toBeGreaterThan(0);
    expect(screen.getAllByText("external").length).toBeGreaterThan(0);
    // Superficie col path.
    expect(screen.getByText("apps/web")).toBeInTheDocument();
    expect(screen.getByText("apps/admin")).toBeInTheDocument();
    // Glossario, invarianti, journey, fonti.
    expect(screen.getByText("Ticket")).toBeInTheDocument();
    expect(screen.getByText("A ticket always has an owner")).toBeInTheDocument();
    expect(screen.getByText("Open a ticket")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();

    // Fatti riservati: intestazione dedicata + nota + il fatto letterale (audit).
    expect(screen.getByText("Confidential facts detected")).toBeInTheDocument();
    expect(
      screen.getByText("Not included in the public documentation — shown here for audit only."),
    ).toBeInTheDocument();
    expect(screen.getByText("18% markup on tokens")).toBeInTheDocument();
    expect(screen.getByText("never state a percentage margin")).toBeInTheDocument();

    // Metadati della generazione (data + commit troncato) nell'header.
    expect(screen.getByText(/Generated/)).toBeInTheDocument();
    expect(screen.getByText("abcdef1234")).toBeInTheDocument();
  });

  it("mostra la sezione esclusioni con title e motivo quando presenti", async () => {
    getDocBrief.mockResolvedValue(
      response({
        productExclusions: [
          { title: "Pricing guide", fact: "leaked the 18% markup in a table" },
        ],
      }),
    );
    renderBrief();

    expect(
      await screen.findByText("Pages excluded from public documentation"),
    ).toBeInTheDocument();
    expect(screen.getByText("Pricing guide")).toBeInTheDocument();
    expect(screen.getByText(/leaked the 18% markup in a table/)).toBeInTheDocument();
  });

  it("nasconde la sezione esclusioni quando la lista è vuota", async () => {
    getDocBrief.mockResolvedValue(response({ productExclusions: [] }));
    renderBrief();

    expect(await screen.findByText("A ticketing product for support teams.")).toBeInTheDocument();
    expect(
      screen.queryByText("Pages excluded from public documentation"),
    ).not.toBeInTheDocument();
  });

  it("brief assente (404): messaggio 'nessun brief, rigenera la documentazione'", async () => {
    getDocBrief.mockRejectedValue(new ApiError(404, "No project brief available", "brief_not_found"));
    renderBrief();

    expect(await screen.findByText("No brief yet")).toBeInTheDocument();
    expect(
      screen.getByText("Regenerate the documentation to produce a project brief."),
    ).toBeInTheDocument();
  });

  it("nasconde il blocco fatti riservati quando non ce ne sono", async () => {
    getDocBrief.mockResolvedValue(response({ brief: { ...FULL_BRIEF, confidentialFacts: [] } }));
    renderBrief();

    expect(await screen.findByText("A ticketing product for support teams.")).toBeInTheDocument();
    expect(screen.queryByText("Confidential facts detected")).not.toBeInTheDocument();
  });
});
