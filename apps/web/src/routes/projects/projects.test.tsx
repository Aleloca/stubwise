import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Route dei progetti con il router vero (memory history) e fetch mockata a
 * livello di rete: lista, creazione (payload POST con credenziali mai
 * rispecchiate), modifica (credenziali vuote = omesse) e vista member.
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

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Demo Shop",
    slug: "demo-shop",
    provider: "github",
    repoUrl: "https://github.com/acme/demo-shop",
    defaultBranch: "main",
    ingestionKey: "0123456789abcdef0123456789abcdef",
    hasCredentials: false,
    webhookConfiguredAt: null,
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

describe("lista progetti", () => {
  it("admin: righe con nome, slug, provider e repo + bottone Nuovo progetto", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () =>
        jsonResponse(200, [
          makeProject(),
          makeProject({
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            name: "Backoffice",
            slug: "backoffice",
            provider: "bitbucket",
            repoUrl: "https://bitbucket.org/acme/backoffice",
          }),
        ]),
    });

    renderApp("/projects");

    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByText("Demo Shop")).toBeInTheDocument();
    expect(screen.getByText("demo-shop")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Bitbucket")).toBeInTheDocument();
    expect(screen.getByText("https://bitbucket.org/acme/backoffice")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /nuovo progetto/i })).toBeInTheDocument();
  });

  it("member: niente bottone Nuovo progetto", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/projects": () => jsonResponse(200, [makeProject()]),
    });

    renderApp("/projects");

    expect(await screen.findByText("Demo Shop")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /nuovo progetto/i })).not.toBeInTheDocument();
  });
});

describe("creazione progetto", () => {
  it("invia il POST con le credenziali e atterra sul dettaglio con la chiave", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    const created = makeProject();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () => jsonResponse(200, []),
      "POST /api/projects": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, created);
      },
      "GET /api/projects/demo-shop": () => jsonResponse(200, created),
    });

    const router = renderApp("/projects/new");

    await screen.findByRole("heading", { name: "Nuovo progetto" });
    await user.type(screen.getByLabelText("Nome"), "Demo Shop");
    await user.selectOptions(screen.getByLabelText("Provider"), "github");
    await user.type(
      screen.getByLabelText("URL repository"),
      "https://github.com/acme/demo-shop",
    );
    await user.type(screen.getByLabelText("Token di accesso"), "ghp_supersegreto");
    await user.click(screen.getByRole("button", { name: "Crea progetto" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/demo-shop"));
    expect(postBody).toEqual({
      name: "Demo Shop",
      provider: "github",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
      credentials: { token: "ghp_supersegreto" },
    });
    // Sul dettaglio campeggia la chiave di ingestion, mai il token inviato.
    expect(await screen.findByText(created.ingestionKey)).toBeInTheDocument();
    expect(screen.queryByText(/ghp_supersegreto/)).not.toBeInTheDocument();
  });

  it("member: /projects/new reindirizza alla lista", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/projects": () => jsonResponse(200, []),
    });

    const router = renderApp("/projects/new");

    await screen.findByRole("heading", { name: "Projects" });
    expect(router.state.location.pathname).toBe("/projects");
  });
});

describe("dettaglio progetto", () => {
  it("admin: form prefillato senza credenziali, PATCH con token vuoto le omette", async () => {
    const user = userEvent.setup();
    let patchBody: unknown;
    const project = makeProject();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects/demo-shop": () => jsonResponse(200, project),
      "GET /api/projects": () => jsonResponse(200, [project]),
      "PATCH /api/projects/demo-shop": (_url, init) => {
        patchBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { ...project, name: "Demo Shop EU" });
      },
    });

    renderApp("/projects/demo-shop");

    const name = await screen.findByLabelText("Nome");
    expect(name).toHaveValue("Demo Shop");
    expect(screen.getByLabelText("Token di accesso")).toHaveValue("");

    await user.clear(name);
    await user.type(name, "Demo Shop EU");
    await user.click(screen.getByRole("button", { name: "Salva modifiche" }));

    expect(await screen.findByText("Modifiche salvate.")).toBeInTheDocument();
    expect(patchBody).toEqual({
      name: "Demo Shop EU",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
    });
  });

  it("mostra DSN e snippet init() costruiti su chiave e slug", async () => {
    const project = makeProject();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects/demo-shop": () => jsonResponse(200, project),
    });

    renderApp("/projects/demo-shop");

    await screen.findByText(project.ingestionKey);
    const dsn = `http://${project.ingestionKey}@localhost:3000/p/demo-shop`;
    expect(screen.getByText(dsn)).toBeInTheDocument();
    const snippet = screen.getByTestId("init-snippet");
    expect(snippet.textContent).toContain('from "@stubwise/sdk/browser"');
    expect(snippet.textContent).toContain(dsn);
  });

  it("admin: con credenziali e webhook configurati mostra il banner 'configurato correttamente'", async () => {
    const project = makeProject({
      hasCredentials: true,
      webhookConfiguredAt: "2026-06-05T09:30:00.000Z",
    });
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects/demo-shop": () => jsonResponse(200, project),
      "GET /api/projects/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
    });

    renderApp("/projects/demo-shop");

    expect(await screen.findByTestId("project-configured-banner")).toHaveTextContent(
      "Progetto configurato correttamente",
    );
    // Le credenziali partono collassate nello stato "configurato".
    expect(screen.getByTestId("credentials-configured")).toBeInTheDocument();
    expect(screen.queryByLabelText("Token di accesso")).not.toBeInTheDocument();
  });

  it("admin: se manca il webhook non mostra il banner complessivo", async () => {
    const project = makeProject({ hasCredentials: true, webhookConfiguredAt: null });
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects/demo-shop": () => jsonResponse(200, project),
      "GET /api/projects/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
    });

    renderApp("/projects/demo-shop");

    // La sezione integrazione c'è (rende il banner assente una condizione vera).
    await screen.findByTestId("init-snippet");
    expect(screen.queryByTestId("project-configured-banner")).not.toBeInTheDocument();
  });

  it("member: sola lettura ma con chiave di ingestion e snippet visibili", async () => {
    const project = makeProject();
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/projects/demo-shop": () => jsonResponse(200, project),
    });

    renderApp("/projects/demo-shop");

    await screen.findByText(project.ingestionKey);
    // Niente form: nessun campo Nome editabile né bottone di salvataggio.
    expect(screen.queryByLabelText("Nome")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salva modifiche" })).not.toBeInTheDocument();
    // Ma l'integrazione c'è: serve anche ai member.
    expect(screen.getByTestId("init-snippet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copia chiave di ingestion" }),
    ).toBeInTheDocument();
  });
});
