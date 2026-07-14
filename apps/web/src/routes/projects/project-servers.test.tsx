import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail, ServerView } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Sezione "Server" del dettaglio progetto col router vero (memory history) e
 * fetch mockata: riuso delle ServerCard filtrate per progetto (`?projectId=`),
 * e stato vuoto con il rimando a Impostazioni → Server. Verifica anche che la
 * sezione sia registrata nella vista progetto (render alla route reale).
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

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Handler = (url: URL, init?: RequestInit) => Response;

/** URL della richiesta lista server (con eventuale query), capturato dal mock. */
let serversRequestUrl: string | null = null;

function mockApi(handlers: Record<string, Handler>) {
  const withDefaults: Record<string, Handler> = {
    "GET /api/auth/me": () =>
      jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } }),
    "GET /api/ai-providers": () => jsonResponse(200, []),
    "GET /api/milestones": () => jsonResponse(200, []),
    [`GET /api/projects/${PROJECT_ID}/widgets`]: () => jsonResponse(200, { widgets: [] }),
    [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, detail()),
    ...handlers,
  };
  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    if (url.pathname === "/api/servers") serversRequestUrl = url.pathname + url.search;
    const method = init?.method ?? "GET";
    const handler = withDefaults[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${raw}`);
    return Promise.resolve(handler(url, init));
  });
}

function detail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: PROJECT_ID,
    name: "Acme Platform",
    slug: "acme-platform",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    ingestionKey: "0123456789abcdef0123456789abcdef",
    nextTicketNumber: 1,
    repositories: [],
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

function server(overrides: Partial<ServerView> = {}): ServerView {
  return {
    id: "s-default",
    name: "Default Server",
    hostname: "host.local",
    status: "online",
    sampleIntervalSeconds: 30,
    agentVersion: "1.0.0",
    alertThresholds: { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
    lastSeenAt: "2026-07-13T10:00:00.000Z",
    createdAt: "2026-06-01T10:00:00.000Z",
    projects: [{ id: PROJECT_ID, name: "Acme Platform" }],
    checksUp: 0,
    checksDown: 0,
    recentCpu: [],
    ...overrides,
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

describe("dettaglio progetto — sezione Server", () => {
  beforeEach(() => {
    serversRequestUrl = null;
  });

  it("progetto con server associati: rende una ServerCard per server, filtrando per progetto", async () => {
    mockApi({
      "GET /api/servers": () =>
        jsonResponse(200, [
          server({ id: "s-1", name: "Web Online", status: "online", recentCpu: [10, 20, 30] }),
          server({ id: "s-2", name: "Db Offline", status: "offline", checksDown: 1 }),
        ]),
    });

    renderApp(`/projects/${PROJECT_ID}`);

    // Le card sono link al dettaglio globale del server (riuso della ServerCard).
    const web = await screen.findByRole("link", { name: /Web Online/ });
    expect(web).toHaveAttribute("href", "/monitor/servers/s-1");
    const db = screen.getByRole("link", { name: /Db Offline/ });
    expect(db).toHaveAttribute("href", "/monitor/servers/s-2");

    // La query lista è filtrata per progetto (?projectId=…).
    expect(serversRequestUrl).toBe(`/api/servers?projectId=${PROJECT_ID}`);

    // Nessuna chiave i18n grezza a schermo.
    expect(document.body.textContent ?? "").not.toMatch(/projects:|monitor:/);
  });

  it("progetto senza server: stato vuoto con il rimando a Impostazioni → Server", async () => {
    mockApi({
      "GET /api/servers": () => jsonResponse(200, []),
    });

    renderApp(`/projects/${PROJECT_ID}`);

    expect(await screen.findByText("// no servers")).toBeInTheDocument();
    // Rimando reale alla pagina di associazione (settings/servers).
    const link = screen.getByRole("link", { name: /Manage in settings/i });
    expect(link).toHaveAttribute("href", "/settings/servers");
    // La query è comunque partita filtrata per progetto.
    expect(serversRequestUrl).toBe(`/api/servers?projectId=${PROJECT_ID}`);
  });
});
