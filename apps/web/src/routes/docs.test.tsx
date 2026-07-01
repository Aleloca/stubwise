import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocSpace } from "../lib/docs-api";
import { createAppRouter } from "../router";

/**
 * Hub Docs con il router vero (memory history) e fetch mockata a livello di
 * rete. Fase 2: gli spazi-repo sono RAGGRUPPATI per progetto (header progetto +
 * card dei suoi repo-spazi). Il raggruppamento è lato client unendo
 * `/api/docs/spaces` (repo-spazi), `/api/repositories` (mappa repo→progetto) e
 * `/api/projects` (nomi). L'header progetto linka alla landing di progetto; le
 * card repo alla vista per-repo esistente.
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

const REPO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPO_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJ_1 = "11111111-1111-4111-8111-111111111111";
const PROJ_2 = "22222222-2222-4222-8222-222222222222";

function makeSpace(overrides: Partial<DocSpace> = {}): DocSpace {
  return {
    repositoryId: REPO_A,
    slug: "demo-shop",
    name: "Demo Shop",
    pageCount: 12,
    lastGenerationAt: "2026-06-20T10:00:00.000Z",
    lastCommitSha: "abc1234def5678",
    ...overrides,
  };
}

/** Repo minimale per la mappa repo→progetto dell'hub. */
function makeRepo(id: string, projectId: string, slug: string, name: string) {
  return {
    id,
    projectId,
    name,
    slug,
    provider: "github",
    repoUrl: "https://example.com/repo.git",
    defaultBranch: "main",
    ingestionKey: "k",
    gitAccountId: "g1",
    gitAccountName: "acct",
    webhookConfiguredAt: null,
    testCommand: null,
    installCommand: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeProject(id: string, name: string, slug: string) {
  return {
    id,
    name,
    slug,
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    repositoryCount: 1,
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
  it("raggruppa gli spazi per progetto: header progetto + card dei repo-spazi", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/docs/spaces": () =>
        jsonResponse(200, [
          makeSpace(),
          makeSpace({
            repositoryId: REPO_B,
            slug: "backoffice",
            name: "Backoffice",
            pageCount: 1,
            lastGenerationAt: null,
            lastCommitSha: null,
          }),
          makeSpace({
            repositoryId: REPO_C,
            slug: "fresh-app",
            name: "Fresh App",
            pageCount: 0,
            lastGenerationAt: null,
            lastCommitSha: null,
          }),
        ]),
      // Repo A e B nel progetto Acme, repo C nel progetto Globex.
      "GET /api/repositories": () =>
        jsonResponse(200, [
          makeRepo(REPO_A, PROJ_1, "demo-shop", "Demo Shop"),
          makeRepo(REPO_B, PROJ_1, "backoffice", "Backoffice"),
          makeRepo(REPO_C, PROJ_2, "fresh-app", "Fresh App"),
        ]),
      "GET /api/projects": () =>
        jsonResponse(200, [
          makeProject(PROJ_1, "Acme", "acme"),
          makeProject(PROJ_2, "Globex", "globex"),
        ]),
    });

    renderApp("/docs");

    expect(await screen.findByRole("heading", { name: "Documentation" })).toBeInTheDocument();

    // Due gruppi-progetto, ciascuno con header e link alla landing di progetto.
    const acme = screen.getByRole("region", { name: "Acme" });
    const globex = screen.getByRole("region", { name: "Globex" });
    expect(within(acme).getByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(within(acme).getByRole("link", { name: "Project documentation" })).toHaveAttribute(
      "href",
      `/docs/project/${PROJ_1}`,
    );
    expect(within(globex).getByRole("link", { name: "Project documentation" })).toHaveAttribute(
      "href",
      `/docs/project/${PROJ_2}`,
    );

    // Il progetto Acme contiene i suoi due repo-spazi; Globex il terzo.
    expect(within(acme).getByText("Demo Shop")).toBeInTheDocument();
    expect(within(acme).getByText("Backoffice")).toBeInTheDocument();
    expect(within(acme).getByText("12 pages")).toBeInTheDocument();
    expect(within(acme).getByText("1 page")).toBeInTheDocument();
    expect(within(globex).getByText("Fresh App")).toBeInTheDocument();
    expect(within(globex).getByText("not generated yet")).toBeInTheDocument();

    // Le card repo linkano alla vista per-repo esistente (param = repositoryId).
    expect(within(acme).getByRole("link", { name: /Demo Shop/ })).toHaveAttribute(
      "href",
      `/docs/${REPO_A}`,
    );
    expect(within(globex).getByRole("link", { name: /Fresh App/ })).toHaveAttribute(
      "href",
      `/docs/${REPO_C}`,
    );
  });

  it("stato vuoto quando nessun progetto ha documentazione", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/docs/spaces": () => jsonResponse(200, []),
      "GET /api/repositories": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
    });

    renderApp("/docs");

    expect(await screen.findByText("// no projects yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Create a project first — each linked project gets a documentation space here.",
      ),
    ).toBeInTheDocument();
  });
});
