import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAccount, Project } from "../lib/api";
import { createAppRouter } from "../router";

/**
 * Wizard di creazione progetto, esercitato tramite la route reale
 * `/projects/new` (il wizard usa `Link`, che richiede il router). Rete mockata
 * via `fetch` globale: account → fetch repository (picker) → fetch branch
 * (preselezionato) → POST col body giusto, più il fallback manuale.
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
    // Route con querystring (branches?repo=...) matchate sul solo path.
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${raw}`);
    return Promise.resolve(handler(url, init));
  });
}

const ACCOUNT: GitAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Account Demo",
  provider: "github",
  createdAt: "2026-06-01T10:00:00.000Z",
};

const REPOS = [
  {
    fullName: "acme/demo-shop",
    name: "demo-shop",
    cloneUrl: "https://github.com/acme/demo-shop.git",
    defaultBranch: "main",
  },
  {
    fullName: "acme/backoffice",
    name: "backoffice",
    cloneUrl: "https://github.com/acme/backoffice.git",
    defaultBranch: "develop",
  },
];

const CREATED: Project = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Demo Shop",
  slug: "demo-shop",
  provider: "github",
  repoUrl: "https://github.com/acme/backoffice.git",
  defaultBranch: "develop",
  ingestionKey: "0123456789abcdef0123456789abcdef",
  gitAccountId: ACCOUNT.id,
  gitAccountName: ACCOUNT.name,
  webhookConfiguredAt: null,
  createdAt: "2026-06-01T10:00:00.000Z",
};

function meHandler(): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } });
}

function renderWizard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ["/projects/new"] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("ProjectWizard — senza account", () => {
  it("mostra il link a Settings e disabilita il submit", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/git-accounts": () => jsonResponse(200, []),
    });
    renderWizard();

    expect(await screen.findByText(/nessun account git/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /account git/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /crea progetto/i })).toBeDisabled();
  });
});

describe("ProjectWizard — flusso completo", () => {
  it("account → repo → branch preselezionato → POST col body giusto", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT]),
      "GET /api/git-accounts/11111111-1111-4111-8111-111111111111/repositories": () =>
        jsonResponse(200, REPOS),
      "GET /api/git-accounts/11111111-1111-4111-8111-111111111111/branches": () =>
        jsonResponse(200, { branches: ["main", "develop", "release"], defaultBranch: "main" }),
      "POST /api/projects": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, CREATED);
      },
      "GET /api/projects/demo-shop": () => jsonResponse(200, CREATED),
    });

    const router = renderWizard();

    await user.type(await screen.findByLabelText("Nome"), "Demo Shop");
    // L'account è preselezionato (unico): i repository vengono caricati.
    await screen.findByText("acme/demo-shop");

    // Scegli backoffice (default develop) per verificare la preselezione branch.
    await user.click(screen.getByRole("button", { name: /acme\/backoffice/ }));

    const branchSelect = await screen.findByLabelText("Branch di default");
    await waitFor(() => expect((branchSelect as HTMLSelectElement).value).toBe("develop"));

    await user.click(screen.getByRole("button", { name: /crea progetto/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/demo-shop"));
    expect(postBody).toEqual({
      name: "Demo Shop",
      gitAccountId: ACCOUNT.id,
      repoUrl: "https://github.com/acme/backoffice.git",
      defaultBranch: "develop",
    });
  });

  it("filtra i repository con la ricerca", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT]),
      "GET /api/git-accounts/11111111-1111-4111-8111-111111111111/repositories": () =>
        jsonResponse(200, REPOS),
    });

    renderWizard();

    await screen.findByText("acme/demo-shop");
    await user.type(screen.getByLabelText(/cerca repository/i), "backoffice");

    expect(screen.queryByRole("button", { name: /acme\/demo-shop/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /acme\/backoffice/ })).toBeInTheDocument();
  });
});

describe("ProjectWizard — fallback manuale", () => {
  it("se il fetch dei repository fallisce mostra l'errore e i campi manuali", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    const created = { ...CREATED, repoUrl: "https://github.com/acme/demo-shop", defaultBranch: "main" };
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/git-accounts": () => jsonResponse(200, [ACCOUNT]),
      "GET /api/git-accounts/11111111-1111-4111-8111-111111111111/repositories": () =>
        jsonResponse(422, { message: "scope repository mancante" }),
      "POST /api/projects": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, created);
      },
      "GET /api/projects/demo-shop": () => jsonResponse(200, created),
    });

    const router = renderWizard();

    await user.type(await screen.findByLabelText("Nome"), "Demo Shop");
    expect(await screen.findByText(/scope repository mancante/i)).toBeInTheDocument();

    await user.type(
      screen.getByLabelText(/url repository/i),
      "https://github.com/acme/demo-shop",
    );
    const branch = screen.getByLabelText(/branch di default/i);
    await user.clear(branch);
    await user.type(branch, "main");
    await user.click(screen.getByRole("button", { name: /crea progetto/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/demo-shop"));
    expect(postBody).toEqual({
      name: "Demo Shop",
      gitAccountId: ACCOUNT.id,
      repoUrl: "https://github.com/acme/demo-shop",
      defaultBranch: "main",
    });
  });
});
