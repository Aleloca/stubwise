import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerView } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Route lista Monitor (`/monitor`) col router vero (memory history) e fetch
 * mockata: griglia di card server, pallino/etichetta di stato, sparkline CPU,
 * evidenza sui server in allarme e stato vuoto. Verifica anche che nessuna
 * chiave i18n grezza finisca a schermo.
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

function meHandler(): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } });
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
    projects: [],
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

describe("sezione Monitor — lista server", () => {
  it("elenca i server con stato, sparkline e conteggio check; evidenzia l'offline", async () => {
    const servers = [
      server({
        id: "s-1",
        name: "Web Online",
        hostname: "web-01",
        status: "online",
        checksUp: 3,
        checksDown: 0,
        recentCpu: [10, 20, 15, 30, 25, 40],
        projects: [{ id: "p-1", name: "Acme Platform" }],
      }),
      server({
        id: "s-2",
        name: "Db Offline",
        hostname: "db-01",
        status: "offline",
        checksUp: 1,
        checksDown: 2,
        recentCpu: [],
      }),
    ];
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/servers": () => jsonResponse(200, servers),
    });

    renderApp("/monitor");

    // Entrambe le card, come link al dettaglio del rispettivo server.
    const online = await screen.findByRole("link", { name: /Web Online/ });
    expect(online).toHaveAttribute("href", "/monitor/servers/s-1");
    const offline = screen.getByRole("link", { name: /Db Offline/ });
    expect(offline).toHaveAttribute("href", "/monitor/servers/s-2");

    // Etichette di stato tradotte (en di default nei test).
    expect(online).toHaveTextContent("Online");
    expect(offline).toHaveTextContent("Offline");

    // Il server in allarme (offline) ha l'accento rosso.
    expect(offline.className).toContain("border-danger");

    // La card online con storico CPU disegna una sparkline (polyline SVG);
    // il badge del progetto associato è presente.
    expect(online.querySelector("svg polyline")).not.toBeNull();
    expect(online).toHaveTextContent("Acme Platform");

    // I conteggi servizi sono esposti agli screen reader in forma leggibile
    // (i glifi ↑/↓ da soli non dicono nulla).
    expect(online.querySelector('[aria-label="3 up / 0 down"]')).not.toBeNull();
    expect(offline.querySelector('[aria-label="1 up / 2 down"]')).not.toBeNull();

    // Nessuna chiave i18n grezza a schermo.
    expect(document.body.textContent ?? "").not.toMatch(/monitor:/);
  });

  it("server mai connesso: placeholder senza dati e CPU assente", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/servers": () =>
        jsonResponse(200, [
          server({
            id: "s-3",
            name: "Fresh Server",
            hostname: null,
            status: "never_connected",
            agentVersion: null,
            lastSeenAt: null,
            recentCpu: [],
          }),
        ]),
    });

    renderApp("/monitor");

    const card = await screen.findByRole("link", { name: /Fresh Server/ });
    expect(card).toHaveTextContent("Never connected");
    expect(card).toHaveTextContent("No data yet");
    // Nessun campione CPU → placeholder "—" e niente sparkline.
    expect(card).toHaveTextContent("—");
    expect(card.querySelector("svg polyline")).toBeNull();
    // Mai connesso NON è uno stato d'allarme: niente accento rosso.
    expect(card.className).not.toContain("border-danger");
  });

  it("server online ma con check giù: accento d'allarme", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/servers": () =>
        jsonResponse(200, [
          server({
            id: "s-4",
            name: "Degraded Server",
            status: "online",
            checksUp: 2,
            checksDown: 1,
            recentCpu: [5, 10, 8],
          }),
        ]),
    });

    renderApp("/monitor");

    const card = await screen.findByRole("link", { name: /Degraded Server/ });
    expect(card).toHaveTextContent("Online");
    expect(card.className).toContain("border-danger");
  });

  it("mostra lo stato vuoto con il rimando alle impostazioni quando non ci sono server", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/servers": () => jsonResponse(200, []),
    });

    renderApp("/monitor");

    expect(await screen.findByText("// no servers")).toBeInTheDocument();
    expect(screen.getByText(/Settings → Servers/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/monitor:/);
  });
});
