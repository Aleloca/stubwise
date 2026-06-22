import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocPage, DocTreeNode } from "../lib/docs-api";
import { createAppRouter } from "../router";

/**
 * Spazio Docs — editing pagine manuali (M7.3) + trigger/stato generazione e
 * ricerca (M7.4). Router vero (memory history), fetch mockata a livello di rete.
 */

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MANUAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
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

function node(
  overrides: Partial<DocTreeNode> & Pick<DocTreeNode, "id" | "slug" | "title" | "kind">,
): DocTreeNode {
  return {
    parentId: null,
    position: 0,
    sourcePath: null,
    isManual: overrides.kind === "manual",
    ...overrides,
  };
}

const TREE: DocTreeNode[] = [
  node({ id: "t1", slug: "tech-overview", title: "Technical overview", kind: "technical" }),
  node({ id: MANUAL_ID, slug: "guide", title: "Guide", kind: "manual" }),
];

function makePage(overrides: Partial<DocPage> & Pick<DocPage, "slug" | "title" | "kind">): DocPage {
  return {
    id: overrides.slug,
    parentId: null,
    position: 0,
    sourcePath: null,
    body: `# ${overrides.title}\n\nBody.`,
    isManual: overrides.kind === "manual",
    commitSha: null,
    updatedAt: "2026-06-20T10:00:00.000Z",
    ...overrides,
  };
}

const MANUAL_PAGE = makePage({
  id: MANUAL_ID,
  slug: "guide",
  title: "Guide",
  kind: "manual",
  body: "# Guide\n\nManual content.",
});

const TECH_PAGE = makePage({
  id: "tech-overview",
  slug: "tech-overview",
  title: "Technical overview",
  kind: "technical",
  commitSha: "abc1234def",
  body: "# Technical overview\n\nGenerated.",
});

/** Handler comuni (tree + status null + pagine), parametrizzati sul ruolo. */
function baseHandlers(role: "admin" | "member" = "member"): Record<string, Handler> {
  return {
    "GET /api/auth/me": meHandler(role),
    [`GET /api/projects/${PROJECT_ID}/docs/tree`]: () => jsonResponse(200, TREE),
    [`GET /api/projects/${PROJECT_ID}/docs/status`]: () =>
      jsonResponse(200, { generation: null, latestJob: null }),
    [`GET /api/projects/${PROJECT_ID}/docs/pages/guide`]: () => jsonResponse(200, MANUAL_PAGE),
    [`GET /api/projects/${PROJECT_ID}/docs/pages/tech-overview`]: () =>
      jsonResponse(200, TECH_PAGE),
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

describe("editing pagine manuali (M7.3)", () => {
  it("crea una pagina manuale e naviga alla pagina creata", async () => {
    const created = makePage({ id: MANUAL_ID, slug: "guide", title: "Guide", kind: "manual" });
    let posted: unknown = null;
    mockApi({
      ...baseHandlers(),
      [`POST /api/projects/${PROJECT_ID}/docs/manual`]: (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return jsonResponse(201, created);
      },
    });
    renderApp(`/docs/${PROJECT_ID}/new`);

    await userEvent.type(
      await screen.findByLabelText("Title"),
      "Guide",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create page" }));

    // Naviga alla pagina creata (render markdown del body).
    expect(await screen.findByRole("article")).toBeInTheDocument();
    expect(posted).toMatchObject({ title: "Guide" });
  });

  it("modifica una pagina manuale via PATCH e mostra il body aggiornato", async () => {
    const updated = makePage({
      id: MANUAL_ID,
      slug: "guide",
      title: "Guide",
      kind: "manual",
      body: "# Guide\n\nUpdated content here.",
    });
    let patched: unknown = null;
    mockApi({
      ...baseHandlers(),
      // Dopo il PATCH la GET della pagina riflette il body aggiornato (la
      // mutation invalida la query → refetch).
      [`GET /api/projects/${PROJECT_ID}/docs/pages/guide`]: () =>
        jsonResponse(200, patched ? updated : MANUAL_PAGE),
      [`PATCH /api/projects/${PROJECT_ID}/docs/manual/${MANUAL_ID}`]: (_url, init) => {
        patched = JSON.parse(String(init?.body));
        return jsonResponse(200, updated);
      },
    });
    renderApp(`/docs/${PROJECT_ID}/guide`);

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    // Editor in modalità modifica.
    expect(await screen.findByText("Edit manual page")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patched).toMatchObject({ title: "Guide" }));
    expect(await screen.findByText("Updated content here.")).toBeInTheDocument();
  });

  it("elimina una pagina manuale e torna all'indice dello spazio", async () => {
    let deleted = false;
    mockApi({
      ...baseHandlers(),
      [`DELETE /api/projects/${PROJECT_ID}/docs/manual/${MANUAL_ID}`]: () => {
        deleted = true;
        return jsonResponse(204, null);
      },
    });
    renderApp(`/docs/${PROJECT_ID}/guide`);

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    // Conferma a due tempi.
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleted).toBe(true));
    // Indice dello spazio: placeholder "seleziona una pagina".
    expect(await screen.findByText("Select a page")).toBeInTheDocument();
  });

  it("conflitto di slug (409): mostra l'errore dedicato", async () => {
    mockApi({
      ...baseHandlers(),
      [`POST /api/projects/${PROJECT_ID}/docs/manual`]: () =>
        jsonResponse(409, { message: "conflict", code: "doc_page_slug_conflict" }),
    });
    renderApp(`/docs/${PROJECT_ID}/new`);

    await userEvent.type(await screen.findByLabelText("Title"), "Guide");
    await userEvent.click(screen.getByRole("button", { name: "Create page" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Slug already used in this project.");
  });

  it("una pagina generata NON mostra i controlli di edit/delete", async () => {
    mockApi(baseHandlers());
    renderApp(`/docs/${PROJECT_ID}/tech-overview`);

    const article = await screen.findByRole("article");
    expect(within(article).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(article).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});
