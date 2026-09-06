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
import type { ProjectDecision } from "../../lib/api";
import { ProjectDecisionsPage } from "./project.$projectId.decisions";

/**
 * Pagina del REGISTRO DECISIONI (Fase 5).
 *
 * Ciò che si sorveglia qui: che il filtro per sorgente viaggi al SERVER (e non
 * sia applicato lato client, che scaricherebbe tutto per mostrarne un pezzo),
 * che una decisione SUPERATA resti visibile e marcata, e che "segna come
 * superata" mandi la PATCH con l'id dell'altra decisione — non un booleano, che
 * perderebbe l'unica informazione utile della marcatura.
 */

const { getMe, getProject, getProjectDecisions, createProjectDecision, patchProjectDecision } =
  vi.hoisted(() => ({
    getMe: vi.fn(),
    getProject: vi.fn(),
    getProjectDecisions: vi.fn(),
    createProjectDecision: vi.fn(),
    patchProjectDecision: vi.fn(),
  }));

vi.mock("../../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/api")>();
  return {
    ...actual,
    getMe,
    getProject,
    getProjectDecisions,
    createProjectDecision,
    patchProjectDecision,
  };
});

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function decision(overrides: Partial<ProjectDecision> = {}): ProjectDecision {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: PROJECT_ID,
    source: "ask_user",
    ticketId: null,
    ticketNumber: null,
    title: "Domanda dell'agente: quale formato?",
    context: null,
    decision: "CSV",
    consequences: "Nessuna dipendenza nuova",
    decidedBy: { id: "u1", email: "ada@example.com" },
    decidedAt: "2026-09-06T10:00:00.000Z",
    supersededById: null,
    createdAt: "2026-09-06T10:00:00.000Z",
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({ getParentRoute: () => rootRoute, id: "authed" });
  const decisionsRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/docs/project/$projectId/decisions",
    component: ProjectDecisionsPage,
  });
  // Le rotte bersaglio dei link devono esistere o l'href non risolve.
  const docsProjectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/docs/project/$projectId",
    component: () => null,
  });
  const ticketRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/tickets/$id",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([decisionsRoute, docsProjectRoute, ticketRoute]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/docs/project/${PROJECT_ID}/decisions`],
    }),
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
  getProjectDecisions.mockResolvedValue([decision()]);
  createProjectDecision.mockResolvedValue(decision({ source: "manual" }));
  patchProjectDecision.mockResolvedValue(decision());
});

afterEach(() => {
  getMe.mockReset();
  getProject.mockReset();
  getProjectDecisions.mockReset();
  createProjectDecision.mockReset();
  patchProjectDecision.mockReset();
});

describe("ProjectDecisionsPage", () => {
  it("mostra le decisioni con decisione, conseguenze e attore", async () => {
    renderPage();
    expect(await screen.findByText("Domanda dell'agente: quale formato?")).toBeInTheDocument();
    expect(screen.getByText("CSV")).toBeInTheDocument();
    expect(screen.getByText(/Nessuna dipendenza nuova/)).toBeInTheDocument();
    expect(screen.getByText(/ada@example.com/)).toBeInTheDocument();
  });

  it("senza decisioni mostra lo stato vuoto, non una lista vuota", async () => {
    getProjectDecisions.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("// no decision recorded yet")).toBeInTheDocument();
  });

  it("il filtro per sorgente viaggia al server, non lato client", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Domanda dell'agente: quale formato?");

    await user.click(screen.getByRole("button", { name: "By hand" }));

    await waitFor(() =>
      expect(getProjectDecisions).toHaveBeenCalledWith(PROJECT_ID, { source: "manual" }),
    );
  });

  it("una decisione superata resta visibile e viene marcata", async () => {
    getProjectDecisions.mockResolvedValue([
      decision({ supersededById: "22222222-2222-4222-8222-222222222222" }),
    ]);
    renderPage();
    expect(await screen.findByText("Domanda dell'agente: quale formato?")).toBeInTheDocument();
    expect(screen.getByText("Superseded")).toBeInTheDocument();
  });

  it("segnare come superata manda l'ID dell'altra decisione", async () => {
    const user = userEvent.setup();
    const other = decision({
      id: "22222222-2222-4222-8222-222222222222",
      title: "La scelta nuova",
    });
    getProjectDecisions.mockResolvedValue([decision(), other]);
    renderPage();
    // Per RUOLO e non per testo: col secondo elemento in lista lo stesso titolo
    // compare anche fra le `option` della select dell'altra riga.
    await screen.findByRole("heading", { name: "Domanda dell'agente: quale formato?" });

    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[0]!, other.id);

    await waitFor(() =>
      expect(patchProjectDecision).toHaveBeenCalledWith(
        PROJECT_ID,
        "11111111-1111-4111-8111-111111111111",
        { supersededById: other.id },
      ),
    );
  });

  it("registra una voce manuale col titolo e la decisione scritti", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Domanda dell'agente: quale formato?");

    await user.type(screen.getByLabelText("Title"), "Niente multi-tenant nella v1");
    await user.type(screen.getByLabelText("Decision"), "Un'istanza per cliente.");
    await user.click(screen.getByRole("button", { name: "Record" }));

    await waitFor(() =>
      expect(createProjectDecision).toHaveBeenCalledWith(PROJECT_ID, {
        title: "Niente multi-tenant nella v1",
        decision: "Un'istanza per cliente.",
      }),
    );
  });

  it("il bottone di registrazione resta spento senza titolo o decisione", async () => {
    renderPage();
    await screen.findByText("Domanda dell'agente: quale formato?");
    expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();
  });
});
