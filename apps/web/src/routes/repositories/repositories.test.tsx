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
    expect(patchBody).toEqual({
      name: "Demo Shop EU",
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
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
