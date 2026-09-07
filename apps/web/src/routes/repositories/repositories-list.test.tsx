import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectListItem, Repository } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Route lista repository (`/repositories`) con il router vero (memory history) e
 * fetch mockata: elenca TUTTI i repository raggruppati per progetto di
 * appartenenza; il pulsante "Aggiungi" è admin-only; stato vuoto.
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
  const withDefaults: Record<string, Handler> = {
    "GET /api/ai-providers": () => jsonResponse(200, []),
    ...handlers,
  };
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const handler = withDefaults[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${raw}`);
    return Promise.resolve(handler(url, init));
  });
}

const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function project(id: string, overrides: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id,
    name: id === PROJECT_A ? "Acme Platform" : "Beta Labs",
    slug: id === PROJECT_A ? "acme-platform" : "beta-labs",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    backlogEnabled: false,
    pulseEnabled: false,
    pulseEveryDays: 3,
    weeklyBriefEnabled: false,
    ingestionKey: "0123456789abcdef0123456789abcdef",
    nextTicketNumber: 1,
    repositoryCount: 1,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

function repo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "r-default",
    projectId: PROJECT_A,
    name: "Storefront",
    slug: "storefront",
    provider: "github",
    repoUrl: "https://github.com/acme/storefront",
    defaultBranch: "main",
    gitAccountId: "acc-1",
    gitAccountName: "GitHub Demo",
    webhookConfiguredAt: null,
    testCommand: null,
    installCommand: null,
    graphEnabled: false,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

function meHandler(role: "admin" | "member"): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role } });
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

describe("lista repository", () => {
  it("admin: elenca i repository raggruppati per progetto, con link al dettaglio e pulsante Aggiungi", async () => {
    const repositories = [
      repo({ id: "r-1", projectId: PROJECT_A, name: "Storefront", slug: "storefront" }),
      repo({
        id: "r-2",
        projectId: PROJECT_B,
        name: "Data Pipeline",
        slug: "data-pipeline",
        repoUrl: "https://github.com/beta/data-pipeline",
        defaultBranch: "develop",
      }),
    ];
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/repositories": () => jsonResponse(200, repositories),
      "GET /api/projects": () => jsonResponse(200, [project(PROJECT_A), project(PROJECT_B)]),
    });

    renderApp("/repositories");

    // Entrambi i repository e i rispettivi progetti di appartenenza.
    const storefront = await screen.findByRole("link", { name: /Storefront/ });
    expect(storefront).toHaveAttribute("href", "/repositories/storefront");
    const pipeline = screen.getByRole("link", { name: /Data Pipeline/ });
    expect(pipeline).toHaveAttribute("href", "/repositories/data-pipeline");

    // Intestazioni di gruppo per progetto.
    expect(screen.getByRole("link", { name: "Acme Platform" })).toHaveAttribute(
      "href",
      `/projects/${PROJECT_A}`,
    );
    expect(screen.getByRole("link", { name: "Beta Labs" })).toBeInTheDocument();

    // Pulsante di aggiunta verso la pagina standalone.
    expect(screen.getByRole("link", { name: "Add repository" })).toHaveAttribute(
      "href",
      "/repositories/new",
    );
  });

  it("member: nessun pulsante Aggiungi", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/repositories": () => jsonResponse(200, [repo()]),
      "GET /api/projects": () => jsonResponse(200, [project(PROJECT_A)]),
    });

    renderApp("/repositories");

    await screen.findByRole("link", { name: /Storefront/ });
    expect(screen.queryByRole("link", { name: "Add repository" })).not.toBeInTheDocument();
  });

  it("stato vuoto quando non ci sono repository", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/repositories": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
    });

    renderApp("/repositories");

    expect(await screen.findByText("// no repositories")).toBeInTheDocument();
  });
});
