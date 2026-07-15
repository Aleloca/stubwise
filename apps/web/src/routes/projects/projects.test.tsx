import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail, ProjectListItem } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Route dei PROGETTI (gruppi) con il router vero (memory history) e fetch
 * mockata: lista (con conteggio repository), creazione inline del gruppo,
 * dettaglio (impostazioni provider/auto-update, elenco repository, eliminazione)
 * e vista member. La configurazione git vive sul repository (test a parte).
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
    // La sezione Widget del dettaglio progetto legge la lista dei widget del
    // progetto: vuota di default (le mutazioni vivono nei test del componente).
    [`GET /api/projects/${PROJECT_ID}/widgets`]: () => jsonResponse(200, { widgets: [] }),
    // La sezione Server legge i server associati al progetto: vuota di default
    // (il riuso della ServerCard e il filtro per progetto vivono in un test a parte).
    "GET /api/servers": () => jsonResponse(200, []),
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

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function listItem(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id: PROJECT_ID,
    name: "Acme Platform",
    slug: "acme-platform",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    ingestionKey: "0123456789abcdef0123456789abcdef",
    nextTicketNumber: 1,
    repositoryCount: 2,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

function detail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: PROJECT_ID,
    name: "Acme Platform",
    slug: "acme-platform",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    ingestionKey: "0123456789abcdef0123456789abcdef",
    nextTicketNumber: 1,
    repositories: [
      { id: "r1", name: "acme-api", slug: "acme-api", provider: "github" },
      { id: "r2", name: "acme-web", slug: "acme-web", provider: "bitbucket" },
    ],
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

describe("lista progetti (gruppi)", () => {
  it("admin: righe con nome, slug, conteggio repository + bottone Nuovo progetto", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () =>
        jsonResponse(200, [
          listItem(),
          listItem({
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            name: "Backoffice",
            slug: "backoffice",
            repositoryCount: 1,
          }),
        ]),
    });

    renderApp("/projects");

    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByText("Acme Platform")).toBeInTheDocument();
    expect(screen.getByText("acme-platform")).toBeInTheDocument();
    expect(screen.getByText("2 repositories")).toBeInTheDocument();
    expect(screen.getByText("Backoffice")).toBeInTheDocument();
    expect(screen.getByText("1 repository")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
  });

  it("member: niente bottone Nuovo progetto", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/projects": () => jsonResponse(200, [listItem()]),
    });

    renderApp("/projects");

    expect(await screen.findByText("Acme Platform")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new project/i })).not.toBeInTheDocument();
  });
});

describe("creazione progetto (gruppo)", () => {
  it("admin: form inline → POST con solo il nome, atterra sul dettaglio del gruppo", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    const created = { ...listItem(), repositoryCount: 0 };
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () => jsonResponse(200, []),
      "POST /api/projects": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, created);
      },
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, detail({ repositories: [] })),
      "GET /api/milestones": () => jsonResponse(200, []),
    });

    const router = renderApp("/projects");

    await user.click(await screen.findByRole("button", { name: /new project/i }));
    await user.type(screen.getByLabelText("Project name"), "Acme Platform");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}`),
    );
    expect(postBody).toEqual({ name: "Acme Platform" });
  });
});

describe("dettaglio progetto (gruppo)", () => {
  it("admin: mostra impostazioni, elenco repository e azione di eliminazione", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, detail()),
      "GET /api/milestones": () => jsonResponse(200, []),
    });

    renderApp(`/projects/${PROJECT_ID}`);

    // Impostazioni del gruppo (provider AI + auto-update).
    expect(await screen.findByLabelText("Name")).toHaveValue("Acme Platform");
    expect(screen.getByLabelText("Project AI provider")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Auto-update documentation on every push"),
    ).toBeInTheDocument();
    // Nessuna config git al livello del gruppo.
    expect(screen.queryByLabelText("Repository URL")).not.toBeInTheDocument();
    // Elenco repository con link al dettaglio del repo.
    const repoLink = screen.getByRole("link", { name: /acme-api/ });
    expect(repoLink).toHaveAttribute("href", "/repositories/acme-api");
    // Azione di eliminazione del progetto.
    expect(screen.getByRole("button", { name: "Delete project" })).toBeInTheDocument();
    // Link per aggiungere un repository.
    expect(screen.getByRole("link", { name: /add repository/i })).toHaveAttribute(
      "href",
      `/projects/${PROJECT_ID}/repositories/new`,
    );
  });

  it("mostra la sezione Integrazione col la chiave di ingestion del progetto e lo snippet", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, detail()),
      "GET /api/milestones": () => jsonResponse(200, []),
    });

    renderApp(`/projects/${PROJECT_ID}`);

    // La chiave di ingestion, salita dal repo al progetto (Fase 3), è mostrata qui.
    expect(await screen.findByText("0123456789abcdef0123456789abcdef")).toBeInTheDocument();
    const snippet = screen.getByTestId("init-snippet");
    expect(snippet.textContent).toContain('from "@stubwise/sdk/browser"');
    // Il DSN usa lo slug di PROGETTO (…/p/<projectSlug>).
    expect(snippet.textContent).toContain("/p/acme-platform");
  });

  it("member: vede comunque la chiave di ingestion del progetto (integrare non richiede admin)", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, detail()),
      "GET /api/milestones": () => jsonResponse(200, []),
    });

    renderApp(`/projects/${PROJECT_ID}`);

    expect(await screen.findByText("0123456789abcdef0123456789abcdef")).toBeInTheDocument();
  });

  it("admin: salvataggio del provider invia il PATCH al gruppo", async () => {
    const user = userEvent.setup();
    let patchBody: unknown;
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/ai-providers": () =>
        jsonResponse(200, [
          {
            id: "p-claude",
            kind: "api_key",
            label: "Claude API",
            position: 0,
            enabled: true,
            secretSet: true,
            createdAt: "2026-06-01T10:00:00.000Z",
            testStatus: "idle",
            testRequestedAt: null,
            testCheckedAt: null,
            testError: null,
          },
        ]),
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, detail()),
      "GET /api/milestones": () => jsonResponse(200, []),
      [`PATCH /api/projects/${PROJECT_ID}`]: (_url, init) => {
        patchBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { ...detail(), aiProviderId: "p-claude" });
      },
    });

    renderApp(`/projects/${PROJECT_ID}`);

    await screen.findByLabelText("Name");
    await user.selectOptions(screen.getByLabelText("Project AI provider"), "p-claude");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
    expect(patchBody).toEqual({ aiProviderId: "p-claude" });
  });

  it("admin: conferma ed elimina il progetto, poi torna alla lista", async () => {
    const user = userEvent.setup();
    let deleted = false;
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, detail()),
      "GET /api/milestones": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, deleted ? [] : [listItem()]),
      [`DELETE /api/projects/${PROJECT_ID}`]: () => {
        deleted = true;
        return jsonResponse(204, null);
      },
    });

    const router = renderApp(`/projects/${PROJECT_ID}`);

    await user.click(await screen.findByRole("button", { name: "Delete project" }));
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
  });

  it("member: sola lettura, niente form né eliminazione", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, detail()),
      "GET /api/milestones": () => jsonResponse(200, []),
    });

    renderApp(`/projects/${PROJECT_ID}`);

    expect(await screen.findByRole("link", { name: /acme-api/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete project" })).not.toBeInTheDocument();
  });
});
