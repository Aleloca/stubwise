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
import type { RepoGraph } from "../../lib/api";
import { DocsGraphView } from "./graph.$projectId";

/**
 * Tab "Grafo" dello spazio Docs, montata in un router minimale che riproduce
 * l'id di rotta `/authed/docs/$projectId/graph` da cui legge i params. Le
 * chiamate API sono mockate a livello di modulo (`../../lib/api`): il mock
 * copre anche `getMe`, da cui passa `meQueryOptions` per il ruolo.
 *
 * Coperti: i cinque stati (spento, mai generato, in corso, fallito, pronto), la
 * separazione admin/membro sui bottoni, il `force` che parte SOLO dal bottone
 * dedicato, l'iframe sandbox e il report markdown nello stato pronto.
 */

const {
  getMe,
  getRepoGraph,
  generateRepoGraph,
  openRepoGraphSetupPr,
  getRepoGraphReport,
  getRepositories,
} = vi.hoisted(() => ({
  getMe: vi.fn(),
  getRepoGraph: vi.fn(),
  generateRepoGraph: vi.fn(),
  openRepoGraphSetupPr: vi.fn(),
  getRepoGraphReport: vi.fn(),
  getRepositories: vi.fn(),
}));

vi.mock("../../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/api")>();
  return {
    ...actual,
    getMe,
    getRepoGraph,
    generateRepoGraph,
    openRepoGraphSetupPr,
    getRepoGraphReport,
    getRepositories,
  };
});

const REPO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Stato del grafo: default "pronto", da restringere caso per caso. */
function graph(overrides: Partial<RepoGraph> = {}): RepoGraph {
  return {
    enabled: true,
    status: "done",
    commitSha: "abcdef1234567890",
    nodeCount: 1200,
    edgeCount: 3400,
    communityCount: 12,
    labeled: true,
    generatedAt: "2026-07-27T10:00:00.000Z",
    setupPrUrl: null,
    error: null,
    jobPending: false,
    setupPrJobPending: false,
    setupPrError: null,
    ...overrides,
  };
}

function renderGraph(role: "admin" | "member" = "admin") {
  getMe.mockResolvedValue({ user: { id: "u1", email: "ada@example.com", role } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({ getParentRoute: () => rootRoute, id: "authed" });
  const spaceRoute = createRoute({ getParentRoute: () => authedRoute, path: "/docs/$projectId" });
  const graphRoute = createRoute({
    getParentRoute: () => spaceRoute,
    path: "/graph",
    component: DocsGraphView,
  });
  // La CTA dello stato "spento" punta al dettaglio del repository (per slug),
  // con l'elenco come ripiego: entrambe le rotte devono esistere nel router di
  // test, altrimenti il Link non risolve l'href.
  const repositoriesRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/repositories",
    component: () => null,
  });
  const repositoryRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/repositories/$slug",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        spaceRoute.addChildren([graphRoute]),
        repositoriesRoute,
        repositoryRoute,
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [`/docs/${REPO_ID}/graph`] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  generateRepoGraph.mockResolvedValue({ queued: true });
  openRepoGraphSetupPr.mockResolvedValue({ queued: true });
  getRepoGraphReport.mockResolvedValue("## Community 1\n\nAuth and sessions.");
  // La CTA "spento" traduce l'id del repository in slug via la lista.
  getRepositories.mockResolvedValue([{ id: REPO_ID, slug: "demo-shop" }]);
});

afterEach(() => {
  getMe.mockReset();
  getRepoGraph.mockReset();
  generateRepoGraph.mockReset();
  openRepoGraphSetupPr.mockReset();
  getRepoGraphReport.mockReset();
  getRepositories.mockReset();
});

describe("DocsGraphView", () => {
  it("toggle spento (admin): spiegazione + link al repository, nessun bottone di generazione", async () => {
    getRepoGraph.mockResolvedValue(graph({ enabled: false, status: "none" }));
    renderGraph("admin");

    expect(await screen.findByText("Graph not enabled")).toBeInTheDocument();
    expect(screen.getByText("This repository has no code graph yet.")).toBeInTheDocument();
    // La CTA porta dove vive il toggle: il dettaglio del repository.
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Enable it in the repository" })).toHaveAttribute(
        "href",
        "/repositories/demo-shop",
      ),
    );
    expect(screen.queryByRole("button", { name: "Generate graph" })).not.toBeInTheDocument();
  });

  it("toggle spento (admin): senza lo slug in lista la CTA ripiega sull'elenco", async () => {
    getRepoGraph.mockResolvedValue(graph({ enabled: false, status: "none" }));
    getRepositories.mockResolvedValue([]);
    renderGraph("admin");

    expect(await screen.findByText("Graph not enabled")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enable it in the repository" })).toHaveAttribute(
      "href",
      "/repositories",
    );
  });

  it("toggle spento (membro): nota 'chiedi a un admin', nessuna CTA al repository", async () => {
    getRepoGraph.mockResolvedValue(graph({ enabled: false, status: "none" }));
    renderGraph("member");

    expect(await screen.findByText("Graph not enabled")).toBeInTheDocument();
    expect(screen.getByText("Ask an admin to enable it for this repository.")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Enable it in the repository" }),
    ).not.toBeInTheDocument();
    // Il membro non deve nemmeno interrogare la lista dei repository.
    expect(getRepositories).not.toHaveBeenCalled();
  });

  it("mai generato (admin): il bottone accoda una build NON forzata", async () => {
    getRepoGraph.mockResolvedValue(graph({ status: "none", commitSha: null, generatedAt: null }));
    renderGraph("admin");

    expect(await screen.findByText("Graph never generated")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Generate graph" }));

    expect(generateRepoGraph).toHaveBeenCalledWith(REPO_ID, { force: false });
  });

  it("mai generato (membro): nessun bottone di generazione", async () => {
    getRepoGraph.mockResolvedValue(graph({ status: "none", commitSha: null, generatedAt: null }));
    renderGraph("member");

    expect(await screen.findByText("Graph never generated")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate graph" })).not.toBeInTheDocument();
  });

  it("job accodato prima della prima build (status none + jobPending): badge 'in coda'", async () => {
    getRepoGraph.mockResolvedValue(
      graph({ status: "none", jobPending: true, commitSha: null, generatedAt: null }),
    );
    renderGraph("admin");

    expect(await screen.findByText("Generation queued…")).toBeInTheDocument();
    expect(screen.getByText("This page refreshes on its own while the job runs.")).toBeInTheDocument();
  });

  it("build in corso: badge 'generazione in corso'", async () => {
    getRepoGraph.mockResolvedValue(
      graph({ status: "running", commitSha: null, generatedAt: null }),
    );
    renderGraph("admin");

    expect(await screen.findByText("Generating the graph…")).toBeInTheDocument();
  });

  it("build fallita (admin): motivo dal server + Riprova che accoda senza force", async () => {
    getRepoGraph.mockResolvedValue(graph({ status: "failed", error: "graphify exit 1" }));
    renderGraph("admin");

    expect(await screen.findByText("Generation failed")).toBeInTheDocument();
    expect(screen.getByText("Reason: graphify exit 1")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(generateRepoGraph).toHaveBeenCalledWith(REPO_ID, { force: false });
  });

  it("build fallita (membro): nessun bottone Riprova", async () => {
    getRepoGraph.mockResolvedValue(graph({ status: "failed", error: "graphify exit 1" }));
    renderGraph("member");

    expect(await screen.findByText("Generation failed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("pronto: metadati, iframe sandbox, report markdown, download e comando CLI", async () => {
    getRepoGraph.mockResolvedValue(graph());
    renderGraph("member");

    // Metadati: contatori plurali, commit corto, badge etichette e auto-update.
    expect(await screen.findByText("1200 nodes")).toBeInTheDocument();
    expect(screen.getByText("3400 edges")).toBeInTheDocument();
    expect(screen.getByText("12 communities")).toBeInTheDocument();
    expect(screen.getByText("commit abcdef1")).toBeInTheDocument();
    expect(screen.getByText("AI labels")).toBeInTheDocument();
    expect(screen.getByText("updated on push")).toBeInTheDocument();

    // Grafo interattivo: iframe isolato, sorgente sull'endpoint html.
    const frame = screen.getByTitle("Interactive graph of the repository");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("src", `/api/repositories/${REPO_ID}/graph/html`);

    // Report delle comunità reso come markdown (l'heading diventa un <h2>).
    expect(await screen.findByRole("heading", { name: "Community 1" })).toBeInTheDocument();
    expect(screen.getByText("Auth and sessions.")).toBeInTheDocument();

    // Uscite: download del graph.json + comando copiabile.
    const download = screen.getByRole("link", { name: "Download graph.json" });
    expect(download).toHaveAttribute("href", `/api/repositories/${REPO_ID}/graph/json`);
    expect(download).toHaveAttribute("download");
    expect(screen.getByText('graphify query "where does authentication live?"')).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy the graphify command" }),
    ).toBeInTheDocument();
  });

  it("pronto (membro): nessuna azione admin", async () => {
    getRepoGraph.mockResolvedValue(graph());
    renderGraph("member");

    expect(await screen.findByText("1200 nodes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rebuild from scratch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open setup PR" })).not.toBeInTheDocument();
  });

  it("pronto (admin): Rigenera senza force, 'da zero' con force, PR di setup", async () => {
    getRepoGraph.mockResolvedValue(graph());
    renderGraph("admin");

    await userEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    expect(generateRepoGraph).toHaveBeenCalledWith(REPO_ID, { force: false });

    await userEvent.click(screen.getByRole("button", { name: "Rebuild from scratch" }));
    expect(generateRepoGraph).toHaveBeenLastCalledWith(REPO_ID, { force: true });
    // Il force parte SOLO dal bottone dedicato.
    expect(generateRepoGraph.mock.calls.filter(([, opts]) => opts.force === true)).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Open setup PR" }));
    expect(openRepoGraphSetupPr).toHaveBeenCalledWith(REPO_ID);
  });

  it("PR di setup già aperta: link al provider al posto del bottone", async () => {
    getRepoGraph.mockResolvedValue(graph({ setupPrUrl: "https://github.com/acme/app/pull/7" }));
    renderGraph("admin");

    const link = await screen.findByRole("link", { name: /View the setup PR/ });
    expect(link).toHaveAttribute("href", "https://github.com/acme/app/pull/7");
    expect(screen.queryByRole("button", { name: "Open setup PR" })).not.toBeInTheDocument();
  });

  it("PR di setup in corso: badge, niente bottone", async () => {
    getRepoGraph.mockResolvedValue(graph({ setupPrJobPending: true }));
    renderGraph("admin");

    expect(await screen.findByText("Opening the PR…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open setup PR" })).not.toBeInTheDocument();
  });

  it("PR di setup fallita: errore mostrato accanto al bottone", async () => {
    getRepoGraph.mockResolvedValue(graph({ setupPrError: "push rejected" }));
    renderGraph("admin");

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open the setup PR.");
    expect(screen.getByRole("alert")).toHaveTextContent("push rejected");
  });

  it("rigenerazione in corso su un grafo pronto: il grafo resta visibile col badge", async () => {
    getRepoGraph.mockResolvedValue(graph({ jobPending: true }));
    renderGraph("admin");

    expect(await screen.findByText("Generating the graph…")).toBeInTheDocument();
    expect(screen.getByTitle("Interactive graph of the repository")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeDisabled();
  });

  it("report non caricabile: messaggio dedicato, il resto della vista resta", async () => {
    getRepoGraph.mockResolvedValue(graph());
    getRepoGraphReport.mockRejectedValue(new Error("boom"));
    renderGraph("member");

    expect(await screen.findByText("Could not load the community report.")).toBeInTheDocument();
    expect(screen.getByTitle("Interactive graph of the repository")).toBeInTheDocument();
  });

  it("stato del grafo non caricabile: messaggio d'errore della tab", async () => {
    getRepoGraph.mockRejectedValue(new Error("boom"));
    renderGraph("admin");

    expect(await screen.findByText("Could not load the graph status.")).toBeInTheDocument();
  });
});
