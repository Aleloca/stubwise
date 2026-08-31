import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboxKeys } from "../lib/queries";
import { createAppRouter } from "../router";
import { useInboxUnreadWatcher } from "./inbox-bell";

/**
 * Campanella dell'inbox: contatore delle non lette e wiring contatore→liste.
 * Il componente è un `<Link>` tipato, quindi va montato dentro il router reale
 * (come in app-layout.test.tsx); l'hook del wiring si prova invece da solo, con
 * un client di query controllato. Asserzioni sulle stringhe inglesi (i18n en).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
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

/** Mock minimo per montare l'app-shell su una pagina leggera (/docs). */
function shellApi(count: number): Record<string, Handler> {
  return {
    "GET /api/auth/me": () =>
      jsonResponse(200, {
        user: { id: "u1", email: "ada@example.com", role: "member", language: "en" },
      }),
    "GET /api/docs/spaces": () => jsonResponse(200, []),
    "GET /api/projects": () => jsonResponse(200, []),
    "GET /api/repositories": () => jsonResponse(200, []),
    "GET /api/inbox/unread-count": () => jsonResponse(200, { count }),
  };
}

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={createAppRouter(queryClient, createMemoryHistory({ initialEntries: ["/docs"] }))}
      />
    </QueryClientProvider>,
  );
}

describe("campanella dell'inbox", () => {
  it("mostra il contatore quando ci sono non lette", async () => {
    mockApi(shellApi(3));
    renderShell();

    // Due istanze: sidebar desktop e top bar mobile, dalla stessa query.
    const bells = await screen.findAllByLabelText("Inbox, 3 unread");
    expect(bells).toHaveLength(2);
    expect(within(bells[0] as HTMLElement).getByText("3")).toBeInTheDocument();
    // Entrambe portano all'inbox.
    for (const bell of bells) expect(bell).toHaveAttribute("href", "/inbox");
  });

  it("a zero non mostra nessun numero", async () => {
    mockApi(shellApi(0));
    renderShell();

    const bells = await screen.findAllByLabelText("Inbox");
    expect(bells).toHaveLength(2);
    // Nessun "0" da leggere e ignorare: la pastiglia proprio non c'è.
    expect(within(bells[0] as HTMLElement).queryByText("0")).not.toBeInTheDocument();
  });

  it("oltre 99 il contatore diventa 99+", async () => {
    mockApi(shellApi(150));
    renderShell();

    const bells = await screen.findAllByLabelText("Inbox, 150 unread");
    expect(within(bells[0] as HTMLElement).getByText("99+")).toBeInTheDocument();
    expect(within(bells[1] as HTMLElement).getByText("99+")).toBeInTheDocument();
  });
});

describe("wiring contatore → liste", () => {
  function Harness() {
    useInboxUnreadWatcher();
    return null;
  }

  it("invalida le liste quando il contatore cambia (e non alla prima lettura)", async () => {
    let count = 2;
    mockApi({ "GET /api/inbox/unread-count": () => jsonResponse(200, { count }) });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    // Primo valore: è solo la baseline, non "un cambiamento" — niente invalidazione.
    await waitFor(() => expect(queryClient.getQueryData(inboxKeys.unread())).toEqual({ count: 2 }));
    expect(invalidate).not.toHaveBeenCalled();

    // Il contatore cambia (nuova notifica arrivata): le liste vanno ricaricate.
    count = 5;
    await queryClient.refetchQueries({ queryKey: inboxKeys.unread() });

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: inboxKeys.lists() }));
  });
});
