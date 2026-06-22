import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAccount, Project } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Route dei progetti con il router vero (memory history) e fetch mockata a
 * livello di rete: lista, creazione tramite wizard (account → repo → branch →
 * POST senza credenziali), modifica (account collegato switchabile) e vista
 * member. Le credenziali non vivono più sul progetto: stanno sull'account git.
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

const ACCOUNT: GitAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "GitHub Demo",
  provider: "github",
  workspace: null,
  createdAt: "2026-06-01T10:00:00.000Z",
};

const ACCOUNT_B: GitAccount = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Bitbucket Prod",
  provider: "bitbucket",
  workspace: "bb-prod",
  createdAt: "2026-06-02T10:00:00.000Z",
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Demo Shop",
    slug: "demo-shop",
    provider: "github",
    repoUrl: "https://github.com/acme/demo-shop",
    defaultBranch: "main",
    ingestionKey: "0123456789abcdef0123456789abcdef",
    gitAccountId: ACCOUNT.id,
    gitAccountName: ACCOUNT.name,
    webhookConfiguredAt: null,
    testCommand: null,
    installCommand: null,
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
    expect(screen.getByRole("link", { name: /new project/i })).toBeInTheDocument();
  });

  it("member: niente bottone Nuovo progetto", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/projects": () => jsonResponse(200, [makeProject()]),
    });

    renderApp("/projects");

    expect(await screen.findByText("Demo Shop")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /new project/i })).not.toBeInTheDocument();
  });
});

describe("creazione progetto", () => {
  it("wizard: scelta account → repo → branch → POST senza credenziali, atterra sul dettaglio", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    const created = makeProject();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT]),
      "GET /api/git-accounts/11111111-1111-4111-8111-111111111111/repositories": () =>
        jsonResponse(200, [
          {
            fullName: "acme/demo-shop",
            name: "demo-shop",
            cloneUrl: "https://github.com/acme/demo-shop",
            defaultBranch: "main",
          },
        ]),
      "GET /api/git-accounts/11111111-1111-4111-8111-111111111111/branches": () =>
        jsonResponse(200, { branches: ["main", "develop"], defaultBranch: "main" }),
      "POST /api/projects": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, created);
      },
      "GET /api/projects/demo-shop": () => jsonResponse(200, created),
      "GET /api/milestones": () => jsonResponse(200, []),
    });

    const router = renderApp("/projects/new");

    await screen.findByRole("heading", { name: "New project" });
    await user.type(screen.getByLabelText("Name"), "Demo Shop");
    // Account preselezionato (unico): i repository si caricano.
    await user.click(await screen.findByRole("button", { name: /acme\/demo-shop/ }));

    const branchSelect = await screen.findByLabelText("Default branch");
    await waitFor(() => expect((branchSelect as HTMLSelectElement).value).toBe("main"));

    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/demo-shop"));
    // Nessuna credenziale nel body: vivono sull'account git.
    expect(postBody).toEqual({
      name: "Demo Shop",
      gitAccountId: ACCOUNT.id,
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
      // Nessun comando di test inserito → null (auto-detect).
      testCommand: null,
      // Nessun comando di installazione inserito → null (auto-rilevato dal lockfile).
      installCommand: null,
    });
    expect(await screen.findByText(created.ingestionKey)).toBeInTheDocument();
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
  it("admin: form senza campi credenziali, PATCH del nome non tocca l'account", async () => {
    const user = userEvent.setup();
    let patchBody: unknown;
    const project = makeProject();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects/demo-shop": () => jsonResponse(200, project),
      "GET /api/milestones": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, [project]),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT, ACCOUNT_B]),
      "PATCH /api/projects/demo-shop": (_url, init) => {
        patchBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { ...project, name: "Demo Shop EU" });
      },
    });

    renderApp("/projects/demo-shop");

    const name = await screen.findByLabelText("Name");
    expect(name).toHaveValue("Demo Shop");
    // Niente campi credenziali sul progetto: vivono sull'account.
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
    // L'account collegato è mostrato e preselezionato.
    expect(screen.getByLabelText("Git account")).toHaveValue(ACCOUNT.id);

    await user.clear(name);
    await user.type(name, "Demo Shop EU");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
    // Account invariato: gitAccountId omesso dal PATCH.
    expect(patchBody).toEqual({
      name: "Demo Shop EU",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
    });
  });

  it("admin: cambiando account il PATCH include il nuovo gitAccountId", async () => {
    const user = userEvent.setup();
    let patchBody: unknown;
    const project = makeProject();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects/demo-shop": () => jsonResponse(200, project),
      "GET /api/milestones": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, [project]),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT, ACCOUNT_B]),
      "PATCH /api/projects/demo-shop": (_url, init) => {
        patchBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { ...project, gitAccountId: ACCOUNT_B.id });
      },
    });

    renderApp("/projects/demo-shop");

    await screen.findByLabelText("Name");
    await user.selectOptions(screen.getByLabelText("Git account"), ACCOUNT_B.id);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
    expect(patchBody).toEqual({
      name: "Demo Shop",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
      gitAccountId: ACCOUNT_B.id,
    });
  });

  it("mostra DSN e snippet init() costruiti su chiave e slug", async () => {
    const project = makeProject();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects/demo-shop": () => jsonResponse(200, project),
      "GET /api/milestones": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, [project]),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT]),
    });

    renderApp("/projects/demo-shop");

    await screen.findByText(project.ingestionKey);
    const dsn = `http://${project.ingestionKey}@localhost:3000/p/demo-shop`;
    expect(screen.getByText(dsn)).toBeInTheDocument();
    const snippet = screen.getByTestId("init-snippet");
    expect(snippet.textContent).toContain('from "@stubwise/sdk/browser"');
    expect(snippet.textContent).toContain(dsn);
  });

  it("admin: con webhook configurato mostra il banner 'configurato correttamente'", async () => {
    const project = makeProject({
      webhookConfiguredAt: "2026-06-05T09:30:00.000Z",
    });
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects/demo-shop": () => jsonResponse(200, project),
      "GET /api/milestones": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, [project]),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT]),
      "GET /api/projects/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
    });

    renderApp("/projects/demo-shop");

    expect(await screen.findByTestId("project-configured-banner")).toHaveTextContent(
      "Project configured correctly",
    );
    // Nessun campo credenziale: vivono sull'account git.
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
  });

  it("admin: se manca il webhook non mostra il banner complessivo", async () => {
    const project = makeProject({ webhookConfiguredAt: null });
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects/demo-shop": () => jsonResponse(200, project),
      "GET /api/milestones": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, [project]),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT]),
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
      "GET /api/milestones": () => jsonResponse(200, []),
    });

    renderApp("/projects/demo-shop");

    await screen.findByText(project.ingestionKey);
    // Niente form: nessun campo Nome editabile né bottone di salvataggio.
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    // Ma l'integrazione c'è: serve anche ai member.
    expect(screen.getByTestId("init-snippet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy ingestion key" }),
    ).toBeInTheDocument();
  });
});
