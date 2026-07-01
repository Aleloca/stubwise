import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router";

/**
 * App-shell responsive: la sidebar desktop (`hidden md:flex`) e la top bar
 * mobile (`md:hidden`) condividono la stessa lista NavLinks; l'hamburger apre il
 * drawer di navigazione, una voce o un cambio rotta lo chiudono, Escape pure.
 * happy-dom non applica le media query al layout, quindi si verificano struttura
 * (classi) + comportamento JS, non il breakpoint visivo.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

type Handler = (url: URL, init?: RequestInit) => Response;

function mockApi(handlers: Record<string, Handler>) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${raw}`);
    return Promise.resolve(handler(url, init));
  });
}

function meHandler(): Handler {
  return () =>
    jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "member" } });
}

function baseApi(): Record<string, Handler> {
  return {
    "GET /api/auth/me": meHandler(),
    // Le rotte montano l'app-shell; mocka i fetch tipici delle pagine landing.
    // L'hub Docs raggruppa per progetto: serve anche progetti + repository.
    "GET /api/docs/spaces": () => jsonResponse(200, []),
    "GET /api/projects": () => jsonResponse(200, []),
    "GET /api/repositories": () => jsonResponse(200, []),
    "GET /api/tickets": () => jsonResponse(200, { items: [], nextCursor: null }),
  };
}

function renderApp(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: [initialPath] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("app-shell responsive", () => {
  it("sidebar desktop con classi hidden md:flex e top bar mobile con md:hidden", async () => {
    mockApi(baseApi());
    renderApp("/docs");

    // Attende il render dello shell.
    expect(await screen.findByRole("heading", { name: "Documentation" })).toBeInTheDocument();

    const aside = document.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside).toHaveClass("hidden");
    expect(aside).toHaveClass("md:flex");

    // La top bar mobile (la barra che contiene l'hamburger) ha md:hidden.
    const hamburger = screen.getByRole("button", { name: "Open navigation" });
    const topBar = hamburger.parentElement as HTMLElement;
    expect(topBar).toHaveClass("md:hidden");
    expect(topBar).toHaveClass("sticky");
  });

  it("rende le NAV_ITEMS sia in sidebar sia nel drawer (stessa sorgente)", async () => {
    mockApi(baseApi());
    renderApp("/docs");
    await screen.findByRole("heading", { name: "Documentation" });

    // Sidebar e drawer sono entrambi montati (il drawer resta nel DOM da chiuso
    // per animare, con aria-hidden). Conto i link via DOM così includo anche
    // quelli del drawer chiuso, fuori dall'accessibility tree.
    const aside = document.querySelector("aside") as HTMLElement;
    const drawerPanel = document.querySelector('[role="dialog"]') as HTMLElement;

    for (const { code, label } of [
      { code: "TKT", label: "Tickets" },
      { code: "PRJ", label: "Projects" },
      { code: "REP", label: "Repositories" },
      { code: "SET", label: "Settings" },
    ]) {
      const inSidebar = within(aside)
        .getAllByRole("link", { hidden: true })
        .filter((el) => el.textContent === `${code}${label}`);
      const inDrawer = within(drawerPanel)
        .getAllByRole("link", { hidden: true })
        .filter((el) => el.textContent === `${code}${label}`);
      expect(inSidebar, `${code} nella sidebar`).toHaveLength(1);
      expect(inDrawer, `${code} nel drawer`).toHaveLength(1);
    }
  });

  it("la voce Repositories in sidebar linka a /repositories", async () => {
    mockApi(baseApi());
    renderApp("/docs");
    await screen.findByRole("heading", { name: "Documentation" });

    const aside = document.querySelector("aside") as HTMLElement;
    const repoLink = within(aside)
      .getAllByRole("link", { hidden: true })
      .find((el) => el.textContent === "REPRepositories");
    expect(repoLink).toBeDefined();
    expect(repoLink).toHaveAttribute("href", "/repositories");
  });

  it("l'hamburger apre il drawer e aria-expanded riflette lo stato", async () => {
    const user = userEvent.setup();
    mockApi(baseApi());
    renderApp("/docs");
    await screen.findByRole("heading", { name: "Documentation" });

    const hamburger = screen.getByRole("button", { name: "Open navigation" });
    expect(hamburger).toHaveAttribute("aria-expanded", "false");
    expect(hamburger).toHaveAttribute("aria-controls", "mobile-nav");

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    // Chiuso: il contenitore del drawer non è interattivo.
    expect(dialog.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");

    await user.click(hamburger);
    expect(hamburger).toHaveAttribute("aria-expanded", "true");
    expect(dialog.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "false");
  });

  it("cliccare una voce nel drawer lo chiude", async () => {
    const user = userEvent.setup();
    mockApi(baseApi());
    renderApp("/docs");
    await screen.findByRole("heading", { name: "Documentation" });

    const hamburger = screen.getByRole("button", { name: "Open navigation" });
    await user.click(hamburger);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "false");

    // Tocca una voce dentro al drawer.
    const ticketLink = within(dialog).getByRole("link", { name: /^TKT Tickets$/ });
    await user.click(ticketLink);

    expect(dialog.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
    expect(hamburger).toHaveAttribute("aria-expanded", "false");
  });

  it("Escape chiude il drawer", async () => {
    const user = userEvent.setup();
    mockApi(baseApi());
    renderApp("/docs");
    await screen.findByRole("heading", { name: "Documentation" });

    const hamburger = screen.getByRole("button", { name: "Open navigation" });
    await user.click(hamburger);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "false");

    await user.keyboard("{Escape}");
    expect(dialog.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
    expect(hamburger).toHaveAttribute("aria-expanded", "false");
  });

  it("un cambio di rotta chiude il drawer", async () => {
    const user = userEvent.setup();
    mockApi(baseApi());
    const router = renderApp("/docs");
    await screen.findByRole("heading", { name: "Documentation" });

    const hamburger = screen.getByRole("button", { name: "Open navigation" });
    await user.click(hamburger);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "false");

    await router.navigate({ to: "/tickets" });
    // Il cambio di rotta chiude il drawer via `useCloseOnRouteChange`: la chiusura
    // avviene in un effect dopo il commit della nuova location, quindi si attende.
    await waitFor(() =>
      expect(dialog.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true"),
    );
    expect(hamburger).toHaveAttribute("aria-expanded", "false");
  });
});
