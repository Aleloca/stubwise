import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MilestoneWithCounts, ProjectTimeline } from "../../lib/api";
import { ProjectRoadmapPage } from "./$projectId.roadmap";

/**
 * Pagina Roadmap (Fase 5): milestone aperte con avanzamento + timeline
 * raggruppata per settimana, sola lettura. API mockate a livello di modulo.
 *
 * Ciò che si sorveglia qui e non nei test dei componenti: che la pagina chieda
 * al server la finestra giusta (i default sono suoi), che i filtri per kind
 * viaggino nella richiesta invece di essere applicati lato client, e che le
 * milestone CHIUSE non finiscano nell'elenco "aperte".
 */

const { getMe, getProject, listMilestones, getProjectTimeline } = vi.hoisted(() => ({
  getMe: vi.fn(),
  getProject: vi.fn(),
  listMilestones: vi.fn(),
  getProjectTimeline: vi.fn(),
}));

vi.mock("../../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/api")>();
  return { ...actual, getMe, getProject, listMilestones, getProjectTimeline };
});

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function milestone(overrides: Partial<MilestoneWithCounts> = {}): MilestoneWithCounts {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: PROJECT_ID,
    name: "v1.0",
    description: null,
    dueDate: null,
    status: "open",
    closedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    counts: { total: 4, completed: 1, byStatus: {} },
    ...overrides,
  };
}

function timeline(overrides: Partial<ProjectTimeline> = {}): ProjectTimeline {
  return {
    from: "2026-08-09T12:00:00.000Z",
    to: "2026-09-06T12:00:00.000Z",
    entries: [],
    ...overrides,
  };
}

function renderRoadmap() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({ getParentRoute: () => rootRoute, id: "authed" });
  const roadmapRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$projectId/roadmap",
    component: ProjectRoadmapPage,
  });
  // Le rotte bersaglio dei link della pagina devono esistere, o l'href non
  // risolve: il ritorno al progetto e il dettaglio ticket delle voci chiuse.
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$projectId",
    component: () => null,
  });
  const ticketRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/tickets/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([roadmapRoute, projectRoute, ticketRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [`/projects/${PROJECT_ID}/roadmap`] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMe.mockResolvedValue({ user: { id: "u1", email: "ada@example.com", role: "admin" } });
  getProject.mockResolvedValue({
    id: PROJECT_ID,
    name: "Prodotto Acme",
    slug: "prodotto-acme",
    repositories: [],
  });
  listMilestones.mockResolvedValue([milestone()]);
  getProjectTimeline.mockResolvedValue(timeline());
});

afterEach(() => {
  getMe.mockReset();
  getProject.mockReset();
  listMilestones.mockReset();
  getProjectTimeline.mockReset();
});

describe("ProjectRoadmapPage", () => {
  it("mostra il nome del progetto e le milestone aperte con l'avanzamento", async () => {
    renderRoadmap();
    expect(await screen.findByText("Prodotto Acme")).toBeInTheDocument();
    expect(await screen.findByText("v1.0")).toBeInTheDocument();
    expect(screen.getByText("1/4 tickets done")).toBeInTheDocument();
  });

  it("le milestone CHIUSE non compaiono fra le aperte", async () => {
    listMilestones.mockResolvedValue([
      milestone({ name: "v0.9", status: "closed", closedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    renderRoadmap();
    expect(await screen.findByText("// no open milestones")).toBeInTheDocument();
    expect(screen.queryByText("v0.9")).not.toBeInTheDocument();
  });

  it("chiede la timeline SENZA kinds: la finestra e i default sono del server", async () => {
    renderRoadmap();
    await waitFor(() => expect(getProjectTimeline).toHaveBeenCalled());
    expect(getProjectTimeline).toHaveBeenCalledWith(PROJECT_ID, { kinds: [] });
  });

  it("rende i gruppi settimanali della timeline", async () => {
    getProjectTimeline.mockResolvedValue(
      timeline({
        entries: [
          {
            kind: "ticket_opened",
            id: "22222222-2222-4222-8222-222222222222",
            at: "2026-09-01T10:00:00.000Z",
            ticketNumber: 7,
            title: "Login rotto",
          },
        ],
      }),
    );
    renderRoadmap();
    expect(await screen.findByText(/Login rotto/)).toBeInTheDocument();
    expect(screen.getAllByRole("group")).toHaveLength(1);
  });

  it("un filtro acceso viaggia al SERVER come elenco di kind", async () => {
    renderRoadmap();
    await waitFor(() => expect(getProjectTimeline).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Pull requests" }));
    await waitFor(() =>
      expect(getProjectTimeline).toHaveBeenLastCalledWith(PROJECT_ID, {
        kinds: ["pr_opened", "pr_merged", "pr_closed"],
      }),
    );
  });

  it("ri-cliccare lo stesso filtro lo spegne e la vista torna completa", async () => {
    // Due risposte DISTINGUIBILI per filtro: spegnere il filtro deve riportare
    // la vista completa, e quella risposta arriva dalla cache — quindi non si
    // può asserire su una nuova chiamata, ma sul contenuto che si rivede.
    getProjectTimeline.mockImplementation(
      async (_id: string, params: { kinds?: string[] } = {}) =>
        timeline({
          entries:
            (params.kinds?.length ?? 0) > 0
              ? []
              : [
                  {
                    kind: "ticket_opened",
                    id: "22222222-2222-4222-8222-222222222222",
                    at: "2026-09-01T10:00:00.000Z",
                    ticketNumber: 7,
                    title: "Login rotto",
                  },
                ],
        }),
    );
    renderRoadmap();
    expect(await screen.findByText(/Login rotto/)).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Pull requests" });
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.queryByText(/Login rotto/)).not.toBeInTheDocument());

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(await screen.findByText(/Login rotto/)).toBeInTheDocument();
  });

  it("timeline vuota: stato vuoto esplicito, non una pagina muta", async () => {
    renderRoadmap();
    expect(await screen.findByText("No events in this period.")).toBeInTheDocument();
  });

  it("timeline non caricabile: lo dice invece di mostrare un vuoto bugiardo", async () => {
    getProjectTimeline.mockRejectedValue(new Error("boom"));
    renderRoadmap();
    expect(await screen.findByText(/could not load the timeline/i)).toBeInTheDocument();
  });
});
