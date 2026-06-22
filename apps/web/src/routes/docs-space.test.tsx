import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocPage, DocTreeNode } from "../lib/docs-api";
import { createAppRouter } from "../router";

/**
 * Spazio Docs con il router vero (memory history) e fetch mockata a livello di
 * rete: i tre gruppi dell'albero (Tecnico/Funzionale/Manuale) con annidamento,
 * la navigazione a una pagina (render markdown + badge sorgente/commit), la
 * pagina manuale senza badge generazione, e l'evidenziazione della pagina
 * attiva.
 */

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "member" } });
}

function node(overrides: Partial<DocTreeNode> & Pick<DocTreeNode, "id" | "slug" | "title" | "kind">): DocTreeNode {
  return {
    parentId: null,
    position: 0,
    sourcePath: null,
    isManual: overrides.kind === "manual",
    ...overrides,
  };
}

// Albero: overview tecnica con un modulo annidato, una pagina funzionale, una
// manuale.
const TREE: DocTreeNode[] = [
  node({ id: "t1", slug: "tech-overview", title: "Technical overview", kind: "technical" }),
  node({
    id: "t2",
    slug: "module-auth",
    title: "Auth module",
    kind: "technical",
    parentId: "t1",
    position: 0,
    sourcePath: "src/auth",
  }),
  node({ id: "f1", slug: "func-overview", title: "Functional overview", kind: "functional" }),
  node({ id: "m1", slug: "getting-started", title: "Getting started", kind: "manual" }),
];

function makePage(overrides: Partial<DocPage> & Pick<DocPage, "slug" | "title" | "kind">): DocPage {
  return {
    id: overrides.slug,
    parentId: null,
    position: 0,
    sourcePath: null,
    body: `# ${overrides.title}\n\nBody for ${overrides.slug}.`,
    isManual: overrides.kind === "manual",
    commitSha: null,
    updatedAt: "2026-06-20T10:00:00.000Z",
    ...overrides,
  };
}

const PAGES: Record<string, DocPage> = {
  "module-auth": makePage({
    slug: "module-auth",
    title: "Auth module",
    kind: "technical",
    sourcePath: "src/auth",
    commitSha: "abc1234def5678",
    body: "# Auth module\n\nThis documents **authentication**.",
  }),
  "getting-started": makePage({
    slug: "getting-started",
    title: "Getting started",
    kind: "manual",
    body: "# Getting started\n\nManual onboarding.",
  }),
};

function treeHandlers(): Record<string, Handler> {
  return {
    "GET /api/auth/me": meHandler(),
    [`GET /api/projects/${PROJECT_ID}/docs/tree`]: () => jsonResponse(200, TREE),
    [`GET /api/projects/${PROJECT_ID}/docs/pages/module-auth`]: () =>
      jsonResponse(200, PAGES["module-auth"]),
    [`GET /api/projects/${PROJECT_ID}/docs/pages/getting-started`]: () =>
      jsonResponse(200, PAGES["getting-started"]),
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

describe("spazio documentazione", () => {
  it("mostra i tre gruppi con le pagine annidate e il placeholder sull'indice", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}`);

    // I tre gruppi.
    expect(await screen.findByRole("button", { name: /Technical/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Functional/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Manual/ })).toBeInTheDocument();

    // Le pagine dell'albero (overview tecnica + modulo annidato, funzionale, manuale).
    const overview = screen.getByRole("link", { name: "Technical overview" });
    const authModule = screen.getByRole("link", { name: "Auth module" });
    expect(overview).toBeInTheDocument();
    expect(authModule).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Functional overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Getting started" })).toBeInTheDocument();

    // I link puntano allo slug.
    expect(authModule).toHaveAttribute(
      "href",
      `/docs/${PROJECT_ID}/module-auth`,
    );

    // Indice: placeholder "seleziona una pagina".
    expect(screen.getByText("Select a page")).toBeInTheDocument();
  });

  it("naviga a una pagina: render markdown + badge sorgente/commit", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}`);

    const authModule = await screen.findByRole("link", { name: "Auth module" });
    await userEvent.click(authModule);

    // Corpo markdown renderizzato (riuso del componente Markdown).
    expect(await screen.findByText("authentication")).toHaveProperty("tagName", "STRONG");
    // Titolo nell'header dell'articolo (l'header del body markdown è separato).
    const article = screen.getByRole("article");
    expect(within(article.querySelector("header")!).getByText("Auth module")).toBeInTheDocument();

    // Badge: documenta source_path + commit (sha breve).
    expect(screen.getByText("documents src/auth")).toBeInTheDocument();
    expect(screen.getByText("generated at commit abc1234")).toBeInTheDocument();
  });

  it("la pagina attiva è evidenziata", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}/module-auth`);

    const authModule = await screen.findByRole("link", { name: "Auth module" });
    await waitFor(() => expect(authModule).toHaveAttribute("data-status", "active"));

    // Un'altra pagina non è attiva.
    expect(screen.getByRole("link", { name: "Functional overview" })).not.toHaveAttribute(
      "data-status",
      "active",
    );
  });

  it("pagina manuale: nessun badge sorgente/commit di generazione", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}/getting-started`);

    const article = await screen.findByRole("article");
    // Titolo nell'header dell'articolo.
    expect(within(article.querySelector("header")!).getByText("Getting started")).toBeInTheDocument();
    // Nessun badge di generazione.
    expect(screen.queryByText(/^documents /)).not.toBeInTheDocument();
    expect(screen.queryByText(/^generated at commit /)).not.toBeInTheDocument();
    // Ma il badge "manual page" è presente.
    expect(within(article).getByText("manual page")).toBeInTheDocument();
  });

  it("404: messaggio amichevole di pagina non trovata", async () => {
    mockApi({
      ...treeHandlers(),
      [`GET /api/projects/${PROJECT_ID}/docs/pages/ghost`]: () =>
        jsonResponse(404, { message: "not found", code: "doc_page_not_found" }),
    });
    renderApp(`/docs/${PROJECT_ID}/ghost`);

    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });
});
