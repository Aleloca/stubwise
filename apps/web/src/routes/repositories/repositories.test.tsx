import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAccount, Repository } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Route dei REPOSITORY con il router vero (memory history) e fetch mockata:
 * dettaglio (config git, integrazione, banner webhook), wizard di aggiunta
 * (account → repo → branch → POST con projectId), e assenza del provider
 * AI/auto-update (saliti al progetto). Vista member in sola lettura.
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
    // Fase 8: la sezione file d'ambiente carica anche gli ambienti del
    // progetto — default vuoto, nessun test qui asserisce sul loro contenuto.
    [`GET /api/projects/${PROJECT_ID}/environments`]: () => jsonResponse(200, []),
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
const REPO_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: REPO_ID,
    projectId: PROJECT_ID,
    name: "Demo Shop",
    slug: "demo-shop",
    provider: "github",
    repoUrl: "https://github.com/acme/demo-shop",
    defaultBranch: "main",
    gitAccountId: ACCOUNT.id,
    gitAccountName: ACCOUNT.name,
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

describe("dettaglio repository", () => {
  it("admin: config git senza provider AI/auto-update, PATCH del nome non tocca l'account", async () => {
    const user = userEvent.setup();
    let patchBody: unknown;
    const repo = makeRepo();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/repositories/demo-shop": () => jsonResponse(200, repo),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT, ACCOUNT_B]),
      "GET /api/git-accounts/11111111-1111-4111-8111-111111111111/branches": () =>
        jsonResponse(200, { branches: ["main", "develop"], defaultBranch: "main" }),
      [`GET /api/repositories/${REPO_ID}/env-files`]: () => jsonResponse(200, []),
      "GET /api/repositories/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
      "PATCH /api/repositories/demo-shop": (_url, init) => {
        patchBody = JSON.parse(String(init?.body));
        // SENZA `warnings`, apposta: è un server più vecchio (il web fa un
        // cast). È la prova della difesa `?? []` nel punto di lettura.
        return jsonResponse(200, { ...repo, name: "Demo Shop EU" });
      },
    });

    renderApp("/repositories/demo-shop");

    const name = await screen.findByLabelText("Name");
    expect(name).toHaveValue("Demo Shop");
    // Provider AI e auto-update sono sul progetto, non qui.
    expect(screen.queryByLabelText("Project AI provider")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Auto-update documentation on every push"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Git account")).toHaveValue(ACCOUNT.id);

    await user.clear(name);
    await user.type(name, "Demo Shop EU");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
    expect(screen.queryByText(/can't read who the main account is/)).not.toBeInTheDocument();
    // `makeRepo()` non ha `reviewGitAccountId`: il revisore resta «nessuno» e
    // il PATCH (che cambia solo il nome) non lo manda.
    expect(screen.getByLabelText("Review account (optional)")).toHaveValue("");
    expect(patchBody).toEqual({
      name: "Demo Shop EU",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
    });
  });

  it("admin: il toggle del knowledge graph riflette lo stato e finisce nella PATCH", async () => {
    const user = userEvent.setup();
    let patchBody: unknown;
    const repo = makeRepo({ graphEnabled: true });
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/repositories/demo-shop": () => jsonResponse(200, repo),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT]),
      "GET /api/git-accounts/11111111-1111-4111-8111-111111111111/branches": () =>
        jsonResponse(200, { branches: ["main"], defaultBranch: "main" }),
      [`GET /api/repositories/${REPO_ID}/env-files`]: () => jsonResponse(200, []),
      "GET /api/repositories/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
      "PATCH /api/repositories/demo-shop": (_url, init) => {
        patchBody = JSON.parse(String(init?.body));
        return jsonResponse(200, { ...repo, graphEnabled: false });
      },
    });

    renderApp("/repositories/demo-shop");

    // Stato corrente del repository (acceso) riflesso nella checkbox.
    const toggle = await screen.findByLabelText("Code knowledge graph");
    expect(toggle).toBeChecked();

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
    // Solo i campi cambiati: il toggle spento e i tre campi sempre inviati.
    expect(patchBody).toEqual({
      name: "Demo Shop",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
      graphEnabled: false,
    });
  });

  it("admin: webhook configurato mostra il banner e il pannello webhook git (niente ingestion)", async () => {
    const repo = makeRepo({ webhookConfiguredAt: "2026-06-05T09:30:00.000Z" });
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/repositories/demo-shop": () => jsonResponse(200, repo),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT]),
      "GET /api/git-accounts/11111111-1111-4111-8111-111111111111/branches": () =>
        jsonResponse(200, { branches: ["main"], defaultBranch: "main" }),
      [`GET /api/repositories/${REPO_ID}/env-files`]: () => jsonResponse(200, []),
      "GET /api/repositories/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
    });

    renderApp("/repositories/demo-shop");

    expect(await screen.findByTestId("repository-configured-banner")).toHaveTextContent(
      "Repository configured correctly",
    );
    // Il webhook git (per-repo) è qui; l'ingestion NON più (salita al progetto).
    expect(await screen.findByTestId("webhook-config")).toBeInTheDocument();
    expect(screen.getByText("s3cr3t")).toBeInTheDocument();
    expect(screen.queryByTestId("init-snippet")).not.toBeInTheDocument();
    // Link allo spazio Docs del repository.
    expect(screen.getByRole("link", { name: /open documentation/i })).toHaveAttribute(
      "href",
      `/docs/${REPO_ID}`,
    );
  });

  function mockDetailWithWarning(repo: Repository, account: GitAccount) {
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/repositories/demo-shop": () => jsonResponse(200, repo),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT, ACCOUNT_B]),
      [`GET /api/git-accounts/${account.id}/branches`]: () =>
        jsonResponse(200, { branches: ["main"], defaultBranch: "main" }),
      [`GET /api/repositories/${REPO_ID}/env-files`]: () => jsonResponse(200, []),
      "GET /api/repositories/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
      "PATCH /api/repositories/demo-shop": () =>
        jsonResponse(200, { ...repo, warnings: ["main_account_identity_unresolved"] }),
    });
  }

  it("admin: il PATCH avvisa che l'identità del principale non si legge (Bitbucket: nomina lo scope)", async () => {
    const user = userEvent.setup();
    const repo = makeRepo({
      provider: "bitbucket",
      repoUrl: "https://bitbucket.org/bb-prod/demo-shop",
      gitAccountId: ACCOUNT_B.id,
      gitAccountName: ACCOUNT_B.name,
    });
    mockDetailWithWarning(repo, ACCOUNT_B);

    renderApp("/repositories/demo-shop");
    await screen.findByLabelText("Name");
    expect(screen.queryByText(/can't read who the main account is/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // Non bloccante: salvato E avvisato.
    expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
    expect(screen.getByText(/can't read who the main account is/)).toBeInTheDocument();
    expect(screen.getByText(/read:user:bitbucket/)).toBeInTheDocument();
  });

  it("admin: su GitHub l'avviso non nomina lo scope di Bitbucket", async () => {
    const user = userEvent.setup();
    mockDetailWithWarning(makeRepo(), ACCOUNT);

    renderApp("/repositories/demo-shop");
    await screen.findByLabelText("Name");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/can't read who the main account is/)).toBeInTheDocument();
    expect(screen.queryByText(/read:user:bitbucket/)).not.toBeInTheDocument();
  });

  it("admin: passando da una repository a un'altra gli avvisi di A non compaiono su B", async () => {
    const user = userEvent.setup();
    const repo = makeRepo();
    const other = makeRepo({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "Other Shop",
      slug: "other-shop",
      repoUrl: "https://github.com/acme/other-shop",
    });
    mockDetailWithWarning(repo, ACCOUNT);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, "http://test.local").pathname;
      if (path === "/api/repositories/other-shop") return Promise.resolve(jsonResponse(200, other));
      if (path === `/api/repositories/${other.id}/env-files`) return Promise.resolve(jsonResponse(200, []));
      if (path === "/api/repositories/other-shop/webhook")
        return Promise.resolve(
          jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/other-shop" }),
        );
      return base(input, init);
    });

    const router = renderApp("/repositories/demo-shop");
    await screen.findByLabelText("Name");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/can't read who the main account is/)).toBeInTheDocument();

    // Stessa rotta, slug diverso: la pagina non si smonta.
    await router.navigate({ to: "/repositories/$slug", params: { slug: "other-shop" } });
    expect(await screen.findByRole("heading", { name: "Other Shop" })).toBeInTheDocument();
    expect(screen.queryByText(/can't read who the main account is/)).not.toBeInTheDocument();
    expect(screen.queryByText("Changes saved.")).not.toBeInTheDocument();
  });

  it("admin: un revisore salvato si preseleziona dal dettaglio", async () => {
    const reviewer: GitAccount = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "GitHub Review",
      provider: "github",
      workspace: null,
      createdAt: "2026-06-03T10:00:00.000Z",
    };
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/repositories/demo-shop": () =>
        jsonResponse(200, makeRepo({ reviewGitAccountId: reviewer.id })),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT, ACCOUNT_B, reviewer]),
      [`GET /api/git-accounts/${ACCOUNT.id}/branches`]: () =>
        jsonResponse(200, { branches: ["main"], defaultBranch: "main" }),
      [`GET /api/repositories/${REPO_ID}/env-files`]: () => jsonResponse(200, []),
      "GET /api/repositories/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
    });

    renderApp("/repositories/demo-shop");

    const select = await screen.findByLabelText("Review account (optional)");
    expect(select).toHaveValue(reviewer.id);
  });

  it("member: sola lettura, niente pannello webhook (admin-only) né ingestion sul repo", async () => {
    const repo = makeRepo();
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/repositories/demo-shop": () => jsonResponse(200, repo),
    });

    renderApp("/repositories/demo-shop");

    // La config git in sola lettura conferma che il dettaglio è renderizzato.
    await screen.findByText("https://github.com/acme/demo-shop");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    // Il toggle del knowledge graph vive nel form: al member non compare affatto.
    expect(screen.queryByLabelText("Code knowledge graph")).not.toBeInTheDocument();
    // Né l'account revisore: si vede e si cambia solo da admin.
    expect(screen.queryByLabelText("Review account (optional)")).not.toBeInTheDocument();
    expect(screen.queryByText(/Review account/)).not.toBeInTheDocument();
    // Ingestion e webhook non compaiono sul repo per il member.
    expect(screen.queryByTestId("init-snippet")).not.toBeInTheDocument();
    expect(screen.queryByTestId("webhook-config")).not.toBeInTheDocument();
  });
});

describe("aggiunta repository (wizard)", () => {
  it("admin: account → repo → branch → POST con projectId, atterra sul dettaglio", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    const created = makeRepo();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
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
      "POST /api/repositories": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, created);
      },
      "GET /api/repositories/demo-shop": () => jsonResponse(200, created),
      "GET /api/projects": () => jsonResponse(200, []),
      [`GET /api/repositories/${REPO_ID}/env-files`]: () => jsonResponse(200, []),
      "GET /api/repositories/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
    });

    const router = renderApp(`/projects/${PROJECT_ID}/repositories/new`);

    await screen.findByRole("heading", { name: "Add a repository" });
    await user.type(screen.getByLabelText("Name"), "Demo Shop");
    await user.click(await screen.findByRole("button", { name: /acme\/demo-shop/ }));

    const branchSelect = await screen.findByLabelText("Default branch");
    await waitFor(() => expect((branchSelect as HTMLSelectElement).value).toBe("main"));

    await user.click(screen.getByRole("button", { name: "Add repository" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/repositories/demo-shop"));
    // Il POST risponde SENZA `warnings` (server più vecchio, il web fa un
    // cast): nessun avviso, e il dettaglio si rende intero.
    await screen.findByLabelText("Name");
    expect(screen.queryByText(/can't read who the main account is/)).not.toBeInTheDocument();
    expect(postBody).toEqual({
      projectId: PROJECT_ID,
      name: "Demo Shop",
      gitAccountId: ACCOUNT.id,
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
      testCommand: null,
      installCommand: null,
    });
  });

  it("admin: creazione con warning → l'avviso è visibile sul dettaglio dove atterra", async () => {
    const user = userEvent.setup();
    const created = makeRepo();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
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
      "POST /api/repositories": () =>
        jsonResponse(201, { ...created, warnings: ["main_account_identity_unresolved"] }),
      // La GET del dettaglio NON porta gli avvisi: arrivano solo con la navigazione.
      "GET /api/repositories/demo-shop": () => jsonResponse(200, created),
      // Il PATCH successivo risponde SENZA avvisi (anche senza il campo).
      "PATCH /api/repositories/demo-shop": () => jsonResponse(200, created),
      "GET /api/projects": () => jsonResponse(200, []),
      [`GET /api/repositories/${REPO_ID}/env-files`]: () => jsonResponse(200, []),
      "GET /api/repositories/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
    });

    const router = renderApp(`/projects/${PROJECT_ID}/repositories/new`);

    await screen.findByRole("heading", { name: "Add a repository" });
    await user.type(screen.getByLabelText("Name"), "Demo Shop");
    await user.click(await screen.findByRole("button", { name: /acme\/demo-shop/ }));
    const branchSelect = await screen.findByLabelText("Default branch");
    await waitFor(() => expect((branchSelect as HTMLSelectElement).value).toBe("main"));
    await user.click(screen.getByRole("button", { name: "Add repository" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/repositories/demo-shop"));
    expect(await screen.findByText(/can't read who the main account is/)).toBeInTheDocument();

    // Un PATCH senza avvisi sostituisce quelli della creazione: spariscono.
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
    expect(screen.queryByText(/can't read who the main account is/)).not.toBeInTheDocument();
  });

  it("admin: l'avviso della creazione si CONSUMA: back/forward non lo rimostrano", async () => {
    const user = userEvent.setup();
    const created = makeRepo();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
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
      "POST /api/repositories": () =>
        jsonResponse(201, { ...created, warnings: ["main_account_identity_unresolved"] }),
      "GET /api/repositories/demo-shop": () => jsonResponse(200, created),
      "GET /api/projects": () => jsonResponse(200, []),
      [`GET /api/repositories/${REPO_ID}/env-files`]: () => jsonResponse(200, []),
      "GET /api/repositories/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
    });

    const router = renderApp(`/projects/${PROJECT_ID}/repositories/new`);
    await screen.findByRole("heading", { name: "Add a repository" });
    await user.type(screen.getByLabelText("Name"), "Demo Shop");
    await user.click(await screen.findByRole("button", { name: /acme\/demo-shop/ }));
    const branchSelect = await screen.findByLabelText("Default branch");
    await waitFor(() => expect((branchSelect as HTMLSelectElement).value).toBe("main"));
    await user.click(screen.getByRole("button", { name: "Add repository" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/repositories/demo-shop"));
    // Mostrato UNA volta, e intanto tolto dalla voce di history: è ciò che un
    // F5 rileggerebbe.
    expect(await screen.findByText(/can't read who the main account is/)).toBeInTheDocument();
    await waitFor(() =>
      expect("repositoryWarnings" in router.history.location.state).toBe(false),
    );

    // Indietro al wizard e di nuovo avanti: il dettaglio si rimonta e rilegge
    // la voce di history, ormai pulita.
    router.history.back();
    await screen.findByRole("heading", { name: "Add a repository" });
    router.history.forward();
    await waitFor(() => expect(router.state.location.pathname).toBe("/repositories/demo-shop"));
    await screen.findByLabelText("Name");
    expect(screen.queryByText(/can't read who the main account is/)).not.toBeInTheDocument();
  });

  it("admin: creazione STANDALONE con warning → l'avviso arriva anche lì", async () => {
    const user = userEvent.setup();
    const created = makeRepo();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () =>
        jsonResponse(200, [
          {
            id: PROJECT_ID,
            name: "Acme",
            slug: "acme",
            description: null,
            aiProviderId: null,
            docAutoUpdate: false,
            repositories: [],
            createdAt: "2026-06-01T10:00:00.000Z",
          },
        ]),
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
      "POST /api/repositories": () =>
        jsonResponse(201, { ...created, warnings: ["main_account_identity_unresolved"] }),
      "GET /api/repositories/demo-shop": () => jsonResponse(200, created),
      [`GET /api/repositories/${REPO_ID}/env-files`]: () => jsonResponse(200, []),
      "GET /api/repositories/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
    });

    const router = renderApp("/repositories/new");

    await user.selectOptions(await screen.findByLabelText("Project"), PROJECT_ID);
    await user.type(await screen.findByLabelText("Name"), "Demo Shop");
    await user.click(await screen.findByRole("button", { name: /acme\/demo-shop/ }));
    const branchSelect = await screen.findByLabelText("Default branch");
    await waitFor(() => expect((branchSelect as HTMLSelectElement).value).toBe("main"));
    await user.click(screen.getByRole("button", { name: "Add repository" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/repositories/demo-shop"));
    expect(await screen.findByText(/can't read who the main account is/)).toBeInTheDocument();
  });

  function mockWizardPost(post: Handler) {
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
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
        jsonResponse(200, { branches: ["main"], defaultBranch: "main" }),
      "POST /api/repositories": post,
    });
  }

  async function submitWizard(user: ReturnType<typeof userEvent.setup>) {
    renderApp(`/projects/${PROJECT_ID}/repositories/new`);
    await screen.findByRole("heading", { name: "Add a repository" });
    await user.type(screen.getByLabelText("Name"), "Demo Shop");
    await user.click(await screen.findByRole("button", { name: /acme\/demo-shop/ }));
    const branchSelect = await screen.findByLabelText("Default branch");
    await waitFor(() => expect((branchSelect as HTMLSelectElement).value).toBe("main"));
    await user.click(screen.getByRole("button", { name: "Add repository" }));
  }

  it("admin: un errore del POST con un code noto si mostra col suo testo, non col message", async () => {
    const user = userEvent.setup();
    mockWizardPost(() =>
      jsonResponse(404, { code: "git_account_not_found", message: "server says no account" }),
    );
    await submitWizard(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Git account not found");
    expect(alert).not.toHaveTextContent("server says no account");
  });

  it("admin: un code senza testo ricade sul message del server", async () => {
    const user = userEvent.setup();
    mockWizardPost(() =>
      jsonResponse(400, { code: "FST_ERR_VALIDATION", message: "body/name must NOT be empty" }),
    );
    await submitWizard(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("body/name must NOT be empty");
  });

  it("member: la rotta di aggiunta reindirizza al dettaglio del progetto", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      [`GET /api/projects/${PROJECT_ID}`]: () =>
        jsonResponse(200, {
          id: PROJECT_ID,
          name: "Acme",
          slug: "acme",
          description: null,
          aiProviderId: null,
          docAutoUpdate: false,
          repositories: [],
          createdAt: "2026-06-01T10:00:00.000Z",
        }),
      "GET /api/milestones": () => jsonResponse(200, []),
    });

    const router = renderApp(`/projects/${PROJECT_ID}/repositories/new`);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}`),
    );
  });
});
