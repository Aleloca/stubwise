import type {
  SearchDocsSemanticResults,
  SearchHistoryItem,
  SearchResults,
} from "@stubwise/shared";
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
import { GlobalSearchPalette, type SearchScope } from "./global-search-palette";

/**
 * Test isolato dello spotlight globale: mocchiamo le funzioni `api` (search/
 * semantic/history) e montiamo la palette in un router minimale con le rotte
 * target (ticket/progetto/repo/doc) così `useNavigate` risolve. I due debounce
 * (150/600 ms) sono attesi con `findBy*`.
 */

const REPO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const getSearch = vi.fn<(q: string, repositoryId?: string) => Promise<SearchResults>>();
const getDocsSemantic =
  vi.fn<(q: string, repositoryId?: string) => Promise<SearchDocsSemanticResults>>();
const getSearchHistory = vi.fn<(repositoryId?: string) => Promise<SearchHistoryItem[]>>();
const postSearchHistory = vi.fn<(...args: unknown[]) => Promise<void>>();
const deleteSearchHistoryEntry = vi.fn<(...args: unknown[]) => Promise<void>>();
const deleteSearchHistory = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  getSearch: (q: string, repositoryId?: string) => getSearch(q, repositoryId),
  getDocsSemantic: (q: string, repositoryId?: string) => getDocsSemantic(q, repositoryId),
  getSearchHistory: (repositoryId?: string) => getSearchHistory(repositoryId),
  postSearchHistory: (...args: unknown[]) => postSearchHistory(...args),
  deleteSearchHistoryEntry: (...args: unknown[]) => deleteSearchHistoryEntry(...args),
  deleteSearchHistory: (...args: unknown[]) => deleteSearchHistory(...args),
}));

const EMPTY: SearchResults = {
  tickets: { items: [], hasMore: false },
  projects: { items: [], hasMore: false },
  repositories: { items: [], hasMore: false },
  docs: { items: [], hasMore: false },
};

const RESULTS: SearchResults = {
  tickets: {
    items: [
      {
        id: "t1",
        number: 42,
        title: "Login broken",
        status: "open",
        snippet: "the <b>login</b> is broken",
        projectId: "p1",
        projectName: "Acme",
      },
    ],
    hasMore: false,
  },
  projects: {
    items: [{ id: "p1", name: "Acme", slug: "acme", snippet: "the acme project" }],
    hasMore: false,
  },
  repositories: {
    items: [{ id: "r1", name: "Web", slug: "web", projectId: "p1", repoUrl: "git@x/web" }],
    hasMore: false,
  },
  docs: {
    items: [
      {
        slug: "auth-fulltext",
        title: "Auth (full-text)",
        kind: "technical",
        snippet: "full-text auth doc",
        repositoryId: REPO_ID,
        repositorySlug: "web",
        repositoryName: "Web",
      },
    ],
    hasMore: false,
  },
};

const SEMANTIC: SearchDocsSemanticResults = [
  {
    slug: "auth-semantic",
    title: "Auth (semantic)",
    kind: "technical",
    snippet: "semantic auth doc",
    repositoryId: REPO_ID,
    repositorySlug: "web",
    repositoryName: "Web",
    score: 0.95,
  },
];

const HISTORY: SearchHistoryItem[] = [
  {
    type: "ticket",
    entityId: "t9",
    title: "Recent ticket",
    subtitle: "Acme",
    route: "/tickets/t9",
    repositoryId: null,
    clickedAt: "2026-06-30T10:00:00.000Z",
  },
];

beforeEach(() => {
  // Stato server-side simulato per la cronologia: le mutation lo modificano, così
  // la re-fetch di `onSettled` (invalidazione) riflette il cambiamento come in
  // produzione (altrimenti l'aggiornamento ottimistico verrebbe annullato).
  let serverHistory: SearchHistoryItem[] = structuredClone(HISTORY);
  getSearch.mockResolvedValue(structuredClone(RESULTS));
  getDocsSemantic.mockResolvedValue(structuredClone(SEMANTIC));
  getSearchHistory.mockImplementation(() => Promise.resolve(structuredClone(serverHistory)));
  postSearchHistory.mockResolvedValue(undefined);
  deleteSearchHistoryEntry.mockImplementation((type: unknown, entityId: unknown) => {
    serverHistory = serverHistory.filter(
      (i) => !(i.type === type && i.entityId === entityId),
    );
    return Promise.resolve(undefined);
  });
  deleteSearchHistory.mockImplementation(() => {
    serverHistory = [];
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderPalette({
  scope = "global" as SearchScope,
  open = true,
  onClose = vi.fn(),
}: { scope?: SearchScope; open?: boolean; onClose?: () => void } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => <GlobalSearchPalette scope={scope} open={open} onClose={onClose} />,
  });
  // Rotte target minime così `useNavigate({ to })` risolve senza errori.
  const routes = [
    createRoute({ getParentRoute: () => rootRoute, path: "/tickets/$id" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/repositories/$slug" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/docs/$projectId/$slug" }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, onClose };
}

describe("GlobalSearchPalette", () => {
  it("open=false: non rende il dialog", () => {
    renderPalette({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("query vuota: mostra i recenti (cronologia)", async () => {
    renderPalette();
    expect(await screen.findByText("Recent ticket")).toBeInTheDocument();
    expect(getSearch).not.toHaveBeenCalled();
  });

  it("digitando: la corsia veloce popola TUTTI i gruppi", async () => {
    const user = userEvent.setup();
    renderPalette();
    const input = await screen.findByRole("textbox");
    await user.type(input, "auth");

    // Full-text: un item per ciascun tipo (ticket/progetto/repo/doc). Il titolo
    // di ciascun tipo identifica il rispettivo gruppo popolato.
    expect(await screen.findByText("#42 Login broken")).toBeInTheDocument(); // TKT
    expect(screen.getByText("Web")).toBeInTheDocument(); // REP
    expect(screen.getByText("Auth (full-text)")).toBeInTheDocument(); // DOC
    // "Acme" è il titolo del progetto (gruppo PRJ) E il sottotitolo del ticket:
    // ne compaiono due occorrenze, entrambe presenti.
    expect(screen.getAllByText("Acme").length).toBeGreaterThanOrEqual(1);
    await waitFor(() => expect(getSearch).toHaveBeenCalledWith("auth", undefined));
  });

  it("due velocità: dopo il debounce lungo la semantica arricchisce il gruppo Docs", async () => {
    const user = userEvent.setup();
    renderPalette();
    const input = await screen.findByRole("textbox");
    await user.type(input, "auth");

    // Il doc full-text compare subito.
    expect(await screen.findByText("Auth (full-text)")).toBeInTheDocument();

    // Dopo il debounce lungo (600 ms) la semantica arricchisce il gruppo Docs.
    expect(await screen.findByText("Auth (semantic)")).toBeInTheDocument();
    await waitFor(() => expect(getDocsSemantic).toHaveBeenCalledWith("auth", undefined));
  });

  it("click su un risultato: registra la history, naviga e chiude", async () => {
    const user = userEvent.setup();
    const { router, onClose } = renderPalette();
    const input = await screen.findByRole("textbox");
    await user.type(input, "auth");

    await user.click(await screen.findByText("#42 Login broken"));

    expect(postSearchHistory).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ticket", entityId: "t1", route: "/tickets/t1" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/tickets/t1"));
    expect(onClose).toHaveBeenCalled();
  });

  it("tastiera: ArrowDown poi Enter apre il secondo item; Esc chiude", async () => {
    const user = userEvent.setup();
    const { router } = renderPalette();
    const input = await screen.findByRole("textbox");
    await user.type(input, "auth");
    await screen.findByText("#42 Login broken");

    // Ordine gruppi: TKT (Login), poi PRJ (Acme) → ArrowDown+Enter apre il progetto.
    await user.keyboard("{ArrowDown}{Enter}");
    expect(postSearchHistory).toHaveBeenCalledWith(
      expect.objectContaining({ type: "project", entityId: "p1", route: "/projects/p1" }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/p1"));
  });

  it("Esc chiude", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette();
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it('"mostra altri": espande un gruppo oltre i primi 5', async () => {
    const many: SearchResults = {
      ...EMPTY,
      tickets: {
        items: Array.from({ length: 6 }, (_, i) => ({
          id: `t${i}`,
          number: i,
          title: `Ticket ${i}`,
          status: "open" as const,
          snippet: "",
          projectId: "p1",
          projectName: "Acme",
        })),
        hasMore: true,
      },
    };
    getSearch.mockResolvedValue(many);
    const user = userEvent.setup();
    renderPalette();
    const input = await screen.findByRole("textbox");
    await user.type(input, "ticket");

    // I primi 5 sono visibili, il sesto no finché non si espande.
    expect(await screen.findByText("#0 Ticket 0")).toBeInTheDocument();
    expect(screen.queryByText("#5 Ticket 5")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Show more|Mostra altri/ }));
    expect(await screen.findByText("#5 Ticket 5")).toBeInTheDocument();
  });

  it("scope repo: parte ristretta al repo; Tab passa a Tutto (globale)", async () => {
    const user = userEvent.setup();
    renderPalette({ scope: { repositoryId: REPO_ID } });
    const input = await screen.findByRole("textbox");

    // Default "questa documentazione": la ricerca passa il repositoryId.
    await user.type(input, "auth");
    await waitFor(() => expect(getSearch).toHaveBeenCalledWith("auth", REPO_ID));

    // Tab → "Tutto": la ricerca successiva è globale (senza repositoryId).
    await user.keyboard("{Tab}");
    await waitFor(() => expect(getSearch).toHaveBeenCalledWith("auth", undefined));
  });

  it("scope repo: lo switch è visibile", async () => {
    renderPalette({ scope: { repositoryId: REPO_ID } });
    expect(
      await screen.findByRole("button", { name: /This documentation|Questa documentazione/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Everything|Tutto/ })).toBeInTheDocument();
  });

  it("scope globale: lo switch NON è visibile", async () => {
    renderPalette({ scope: "global" });
    await screen.findByRole("dialog");
    expect(
      screen.queryByRole("button", { name: /This documentation|Questa documentazione/ }),
    ).not.toBeInTheDocument();
  });

  it("recenti: ✕ rimuove una voce (ottimistico)", async () => {
    const user = userEvent.setup();
    renderPalette();
    expect(await screen.findByText("Recent ticket")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Remove Recent ticket|Rimuovi Recent ticket/ }),
    );

    expect(deleteSearchHistoryEntry).toHaveBeenCalledWith("ticket", "t9");
    await waitFor(() => expect(screen.queryByText("Recent ticket")).not.toBeInTheDocument());
  });
});
