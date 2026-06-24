import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocHistoryEntry, DocSearchResult } from "../lib/docs-api";
import { DocsCommandPalette } from "./docs-command-palette";

/**
 * Test isolato della command palette: mocchiamo le funzioni `docs-api`
 * (history/search/mutation) e montiamo il componente in un router minimale
 * con la rotta target `/docs/$projectId/$slug` (la palette naviga con
 * `useNavigate`). Il debounce 250ms si gestisce con `findBy*` (attesa reale).
 */

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// --- Mock del client API ---
const getDocsHistory = vi.fn<(projectId: string) => Promise<DocHistoryEntry[]>>();
const searchDocs = vi.fn<(projectId: string, q: string) => Promise<DocSearchResult[]>>();
const recordDocsHistoryClick = vi.fn<(...args: unknown[]) => Promise<void>>();
const deleteDocsHistoryEntry = vi.fn<(...args: unknown[]) => Promise<void>>();
const clearDocsHistory = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock("../lib/docs-api", async (importOriginal) => ({
  // Partial mock: `queries.ts` importa altre funzioni del modulo (es.
  // `getDocSpaces`); sostituiamo solo quelle usate dalla palette.
  ...(await importOriginal<typeof import("../lib/docs-api")>()),
  getDocsHistory: (projectId: string) => getDocsHistory(projectId),
  searchDocs: (projectId: string, q: string) => searchDocs(projectId, q),
  recordDocsHistoryClick: (...args: unknown[]) => recordDocsHistoryClick(...args),
  deleteDocsHistoryEntry: (...args: unknown[]) => deleteDocsHistoryEntry(...args),
  clearDocsHistory: (...args: unknown[]) => clearDocsHistory(...args),
}));

const HISTORY: DocHistoryEntry[] = [
  { slug: "getting-started", title: "Getting started", kind: "manual", clickedAt: "2026-06-24T10:00:00.000Z" },
  { slug: "tech-overview", title: "Technical overview", kind: "technical", clickedAt: "2026-06-24T09:00:00.000Z" },
];

const RESULTS: DocSearchResult[] = [
  {
    slug: "module-auth",
    title: "Auth module",
    kind: "technical",
    snippet: "Handles authentication and sessions.",
    score: 0.9,
    source: "hybrid",
  },
  {
    slug: "auth-flow",
    title: "Auth flow",
    kind: "functional",
    snippet: "The login flow end to end.",
    score: 0.8,
    source: "hybrid",
  },
];

beforeEach(() => {
  // Stato server-side simulato: le mutation lo modificano così la
  // re-fetch di `onSettled` (invalidazione) riflette il cambiamento, come in
  // produzione. Senza questo, l'invalidazione riporterebbe la lista intera e
  // l'aggiornamento ottimistico verrebbe annullato dal refetch.
  let serverHistory: DocHistoryEntry[] = structuredClone(HISTORY);
  getDocsHistory.mockImplementation(() => Promise.resolve(structuredClone(serverHistory)));
  searchDocs.mockResolvedValue(structuredClone(RESULTS));
  recordDocsHistoryClick.mockResolvedValue(undefined);
  deleteDocsHistoryEntry.mockImplementation((_projectId: unknown, slug: unknown) => {
    serverHistory = serverHistory.filter((entry) => entry.slug !== slug);
    return Promise.resolve(undefined);
  });
  clearDocsHistory.mockImplementation(() => {
    serverHistory = [];
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderPalette({ open = true, onClose = vi.fn() }: { open?: boolean; onClose?: () => void } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <DocsCommandPalette projectId={PROJECT_ID} open={open} onClose={onClose} />
    ),
  });
  const spaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs/$projectId" });
  const pageRoute = createRoute({ getParentRoute: () => spaceRoute, path: "/$slug" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([spaceRoute.addChildren([pageRoute])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, onClose };
}

describe("DocsCommandPalette", () => {
  it("open=false: non rende il dialog", () => {
    renderPalette({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("open=true: rende il dialog con l'input a fuoco", async () => {
    renderPalette();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    const input = within(dialog).getByRole("textbox");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("input vuoto: mostra le voci RECENTI", async () => {
    renderPalette();
    expect(await screen.findByText("Getting started")).toBeInTheDocument();
    expect(screen.getByText("Technical overview")).toBeInTheDocument();
    expect(searchDocs).not.toHaveBeenCalled();
  });

  it('digitando "auth" compaiono i risultati (titolo + snippet)', async () => {
    const user = userEvent.setup();
    renderPalette();
    const input = await screen.findByRole("textbox");
    await user.type(input, "auth");

    // Oltre il debounce: i risultati mockati compaiono.
    expect(await screen.findByText("Auth module")).toBeInTheDocument();
    expect(screen.getByText("Handles authentication and sessions.")).toBeInTheDocument();
    await waitFor(() => expect(searchDocs).toHaveBeenCalledWith(PROJECT_ID, "auth"));
  });

  it("click su un risultato: registra il click, naviga e chiude", async () => {
    const user = userEvent.setup();
    const { router, onClose } = renderPalette();
    const input = await screen.findByRole("textbox");
    await user.type(input, "auth");

    await user.click(await screen.findByText("Auth module"));

    expect(recordDocsHistoryClick).toHaveBeenCalledWith(PROJECT_ID, {
      slug: "module-auth",
      title: "Auth module",
      kind: "technical",
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/docs/${PROJECT_ID}/module-auth`),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("✕ su una voce recente: chiama deleteEntry e la riga sparisce (optimistic)", async () => {
    const user = userEvent.setup();
    renderPalette();
    expect(await screen.findByText("Getting started")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Remove Getting started|Rimuovi Getting started/ }),
    );

    expect(deleteDocsHistoryEntry).toHaveBeenCalledWith(PROJECT_ID, "getting-started");
    await waitFor(() => expect(screen.queryByText("Getting started")).not.toBeInTheDocument());
    // L'altra voce resta.
    expect(screen.getByText("Technical overview")).toBeInTheDocument();
  });

  it('"Cancella tutto": svuota la lista', async () => {
    const user = userEvent.setup();
    renderPalette();
    expect(await screen.findByText("Getting started")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Clear all|Cancella tutto/ }));

    expect(clearDocsHistory).toHaveBeenCalledWith(PROJECT_ID);
    await waitFor(() => expect(screen.queryByText("Getting started")).not.toBeInTheDocument());
    expect(screen.queryByText("Technical overview")).not.toBeInTheDocument();
  });

  it("tastiera: ArrowDown poi Enter apre la seconda voce", async () => {
    const user = userEvent.setup();
    const { router, onClose } = renderPalette();
    const input = await screen.findByRole("textbox");
    await user.type(input, "auth");
    await screen.findByText("Auth module");

    await user.keyboard("{ArrowDown}{Enter}");

    // La seconda voce di RESULTS è "Auth flow" (slug auth-flow).
    expect(recordDocsHistoryClick).toHaveBeenCalledWith(PROJECT_ID, {
      slug: "auth-flow",
      title: "Auth flow",
      kind: "functional",
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/docs/${PROJECT_ID}/auth-flow`),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("Esc chiama onClose", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("alla chiusura ripristina il focus all'elemento che ce l'aveva", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // Wrapper controllato: un trigger <button> + la palette. Aprendo da un
    // trigger a fuoco e poi chiudendo (Esc), il focus deve tornare al trigger.
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Apri palette
          </button>
          <DocsCommandPalette projectId={PROJECT_ID} open={open} onClose={() => setOpen(false)} />
        </>
      );
    }

    const rootRoute = createRootRoute({ component: Harness });
    const spaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs/$projectId" });
    const pageRoute = createRoute({ getParentRoute: () => spaceRoute, path: "/$slug" });
    const router = createRouter({
      routeTree: rootRoute.addChildren([spaceRoute.addChildren([pageRoute])]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const trigger = await screen.findByRole("button", { name: "Apri palette" });
    trigger.focus();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(input).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("mousedown sul backdrop chiama onClose, dentro il pannello no", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette();
    const dialog = await screen.findByRole("dialog");

    // Mousedown dentro il pannello: NON chiude.
    await user.pointer({ keys: "[MouseLeft>]", target: dialog });
    expect(onClose).not.toHaveBeenCalled();

    // Mousedown sul backdrop (il genitore del dialog): chiude.
    const backdrop = dialog.parentElement as HTMLElement;
    await user.pointer({ keys: "[MouseLeft>]", target: backdrop });
    expect(onClose).toHaveBeenCalled();
  });

  it("mentre cerca mostra lo skeleton di caricamento, poi i risultati", async () => {
    // Promise controllata: la ricerca resta in volo finché non la risolviamo,
    // così possiamo asserire lo stato di caricamento.
    let resolveSearch: (value: DocSearchResult[]) => void = () => {};
    searchDocs.mockImplementation(
      () =>
        new Promise<DocSearchResult[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const user = userEvent.setup();
    renderPalette();
    const input = await screen.findByRole("textbox");
    await user.type(input, "auth");

    // In volo: compare lo skeleton (role=status con label "Searching…").
    expect(await screen.findByRole("status", { name: /Searching|Ricerca/ })).toBeInTheDocument();
    expect(screen.queryByText("Auth module")).not.toBeInTheDocument();

    // Attendi che la ricerca sia effettivamente partita (lo skeleton compare già
    // durante il debounce, prima della chiamata): solo allora `resolveSearch`
    // punta alla promise reale che React Query sta attendendo.
    await waitFor(() => expect(searchDocs).toHaveBeenCalledWith(PROJECT_ID, "auth"));

    // Risolta: lo skeleton sparisce e compaiono i risultati.
    resolveSearch(structuredClone(RESULTS));
    expect(await screen.findByText("Auth module")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /Searching|Ricerca/ })).not.toBeInTheDocument();
  });

  it("nessun risultato: mostra il messaggio no-results", async () => {
    searchDocs.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPalette();
    const input = await screen.findByRole("textbox");
    await user.type(input, "zzz");

    // Dopo il debounce: searchDocs ritorna [] → messaggio no-results.
    expect(await screen.findByText(/No results|Nessun risultato/)).toBeInTheDocument();
  });

  it("✕ con delete che fallisce: rollback ottimistico (la riga ricompare)", async () => {
    deleteDocsHistoryEntry.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderPalette();
    expect(await screen.findByText("Getting started")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Remove Getting started|Rimuovi Getting started/ }),
    );

    expect(deleteDocsHistoryEntry).toHaveBeenCalledWith(PROJECT_ID, "getting-started");
    // Dopo il settle (onError ripristina + invalidate refetcha lo stato intero):
    // la voce torna presente.
    await waitFor(() => expect(screen.getByText("Getting started")).toBeInTheDocument());
    expect(screen.getByText("Technical overview")).toBeInTheDocument();
  });
});
