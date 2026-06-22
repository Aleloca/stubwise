import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocSpace } from "../lib/docs-api";
import { createAppRouter } from "../router";

/**
 * Hub Docs con il router vero (memory history) e fetch mockata a livello di
 * rete: l'elenco degli spazi (nome/slug, conteggio pagine, ultima generazione),
 * il link allo spazio del progetto, la voce di sidebar "Documentation" e lo
 * stato vuoto.
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

function meHandler(role: "admin" | "member"): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role } });
}

function makeSpace(overrides: Partial<DocSpace> = {}): DocSpace {
  return {
    projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "demo-shop",
    name: "Demo Shop",
    pageCount: 12,
    lastGenerationAt: "2026-06-20T10:00:00.000Z",
    lastCommitSha: "abc1234def5678",
    ...overrides,
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

describe("hub documentazione", () => {
  it("lista gli spazi: nome, slug, conteggio pagine e link allo spazio", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/docs/spaces": () =>
        jsonResponse(200, [
          makeSpace(),
          makeSpace({
            projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            slug: "backoffice",
            name: "Backoffice",
            pageCount: 1,
            lastGenerationAt: null,
            lastCommitSha: null,
          }),
        ]),
    });

    renderApp("/docs");

    expect(await screen.findByRole("heading", { name: "Documentation" })).toBeInTheDocument();
    // Sidebar: la voce Docs è presente.
    expect(screen.getByRole("link", { name: /^DOC Documentation$/ })).toBeInTheDocument();

    // Primo spazio: nome, slug, conteggio plurale.
    expect(screen.getByText("Demo Shop")).toBeInTheDocument();
    expect(screen.getByText("demo-shop")).toBeInTheDocument();
    expect(screen.getByText("12 pages")).toBeInTheDocument();
    // Secondo spazio: conteggio singolare e stato "solo manuali".
    expect(screen.getByText("Backoffice")).toBeInTheDocument();
    expect(screen.getByText("1 page")).toBeInTheDocument();
    expect(screen.getByText("manual pages only")).toBeInTheDocument();

    // Il link punta allo spazio del progetto.
    const spaceLink = screen.getByRole("link", { name: /Demo Shop/ });
    expect(spaceLink).toHaveAttribute(
      "href",
      "/docs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });

  it("stato vuoto quando non ci sono spazi", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/docs/spaces": () => jsonResponse(200, []),
    });

    renderApp("/docs");

    expect(await screen.findByText("// no documentation spaces")).toBeInTheDocument();
    expect(
      screen.getByText("Generate documentation from a project space to populate the hub."),
    ).toBeInTheDocument();
  });
});
