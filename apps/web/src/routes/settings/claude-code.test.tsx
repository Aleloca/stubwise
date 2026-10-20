import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../../router";
import { buildInstallCommand } from "./claude-code";

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

function mockApi(handlers: Record<string, (init?: RequestInit) => Response>) {
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const handler = handlers[`${init?.method ?? "GET"} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${raw}`);
    return Promise.resolve(handler(init));
  });
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
}

const me = () =>
  jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "member" } });

describe("buildInstallCommand", () => {
  it("produce esattamente il comando d'installazione", () => {
    expect(buildInstallCommand("https://sw.example.com", "stw_pat_abc")).toBe(
      "npx -y @stubwise/mcp setup --url https://sw.example.com --token stw_pat_abc && claude plugin marketplace add Aleloca/stubwise --sparse .claude-plugin plugins && claude plugin install stubwise@stubwise",
    );
  });
});

describe("Impostazioni — Claude Code", () => {
  it("un member vede il link di navigazione", async () => {
    mockApi({ "GET /api/auth/me": me });
    renderApp("/settings/claude-code");
    expect(await screen.findByRole("link", { name: "Claude Code" })).toBeInTheDocument();
  });

  it("dice dove si incolla il comando e che serve Node.js, con il link", async () => {
    mockApi({ "GET /api/auth/me": me });
    renderApp("/settings/claude-code");

    expect(await screen.findByText(/PowerShell 7/)).toBeInTheDocument();
    expect(screen.getByText(/macOS or Linux/)).toBeInTheDocument();
    expect(screen.getByText(/You need Node\.js/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "nodejs.org" })).toHaveAttribute(
      "href",
      "https://nodejs.org",
    );
  });

  it("«Crea il comando» crea un token e mostra il comando che lo contiene", async () => {
    const user = userEvent.setup();
    let body: unknown;
    mockApi({
      "GET /api/auth/me": me,
      "POST /api/pats": (init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse(201, {
          id: "p1",
          name: "Claude Code",
          lastUsedAt: null,
          expiresAt: null,
          createdAt: "2026-10-19T10:00:00.000Z",
          token: "stw_pat_zzz",
        });
      },
    });
    renderApp("/settings/claude-code");

    await user.click(await screen.findByRole("button", { name: "Create the command" }));

    const cmd = await screen.findByText(/--token stw_pat_zzz/);
    expect(cmd.textContent).toContain(`--url ${window.location.origin}`);
    expect(body).toMatchObject({ name: "Claude Code" });
    expect(document.body.textContent ?? "").not.toMatch(/settings:/);
  });
});
