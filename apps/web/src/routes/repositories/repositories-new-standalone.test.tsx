import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAccount, ProjectListItem, Repository } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Route aggiunta STANDALONE (`/repositories/new`) con il router vero e fetch
 * mockata: selettore di progetto, wizard che compare solo a progetto scelto,
 * POST con il projectId selezionato, guardia admin-only sulla route.
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

function project(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id: PROJECT_ID,
    name: "Acme Platform",
    slug: "acme-platform",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    dailyReportEnabled: false,
    backlogEnabled: false,
    pulseEnabled: false,
    pulseEveryDays: 3,
    ingestionKey: "0123456789abcdef0123456789abcdef",
    nextTicketNumber: 1,
    repositoryCount: 0,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

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

describe("aggiunta repository standalone", () => {
  it("admin: scelto un progetto compare il wizard; il submit POSTa col projectId scelto", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    const created = makeRepo();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () => jsonResponse(200, [project()]),
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
      [`GET /api/repositories/${REPO_ID}/env-files`]: () => jsonResponse(200, []),
      "GET /api/repositories/demo-shop/webhook": () =>
        jsonResponse(200, { webhookSecret: "s3cr3t", webhookPath: "/webhooks/git/demo-shop" }),
    });

    const router = renderApp("/repositories/new");

    // Prima di scegliere il progetto il wizard non è montato.
    await screen.findByRole("heading", { name: "Add a repository" });
    const projectSelect = screen.getByLabelText("Project");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    // Scelto il progetto, compare il wizard.
    await user.selectOptions(projectSelect, PROJECT_ID);
    await user.type(await screen.findByLabelText("Name"), "Demo Shop");
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

  it("nessun progetto: messaggio con link per crearne uno, niente wizard", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT]),
    });

    renderApp("/repositories/new");

    await screen.findByRole("heading", { name: "Add a repository" });
    expect(screen.getByText("// no projects")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/projects");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("member: la rotta standalone reindirizza alla lista", async () => {
    mockApi({
      "GET /api/auth/me": meHandler("member"),
      "GET /api/repositories": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
    });

    const router = renderApp("/repositories/new");

    await waitFor(() => expect(router.state.location.pathname).toBe("/repositories"));
  });
});
