import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerCheck, ServerDetail, ServerMetricsResponse } from "../../lib/api";
import { createAppRouter } from "../../router";

/**
 * Route dettaglio server (`/monitor/servers/$serverId`) col router vero (memory
 * history) e fetch mockata. uPlot è mockato: i pannelli si montano senza
 * disegnare davvero. Verifica header (stato + dati stantii), selettore range
 * (URL metriche con from/to quantizzati), nota `truncated`, tabella servizi coi
 * badge, tabella check (DSN mai a schermo, down evidenziato) e il submit soglie
 * (oggetto COMPLETO, full-replacement).
 */

// uPlot non funziona in happy-dom: lo si mocka a costruttore no-op con i metodi
// che il wrapper chiama (destroy in cleanup). L'import del CSS è innocuo.
vi.mock("uplot", () => ({
  default: vi.fn(() => ({ destroy: vi.fn(), setData: vi.fn(), setSize: vi.fn() })),
}));

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

function urlOf(input: RequestInfo | URL): URL {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  return new URL(raw, "http://test.local");
}

function mockApi(handlers: Record<string, Handler>) {
  fetchMock.mockImplementation((input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`fetch non mockata per ${method} ${url.pathname}`);
    return Promise.resolve(handler(url, init));
  });
}

function meHandler(): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "admin" } });
}

/** Range (from/to in ms, checkId) di ogni chiamata metriche registrata. */
function metricsRanges() {
  return fetchMock.mock.calls
    .map(([input]) => urlOf(input as RequestInfo | URL))
    .filter((u) => u.pathname.endsWith("/metrics"))
    .map((u) => ({
      from: Date.parse(u.searchParams.get("from") ?? ""),
      to: Date.parse(u.searchParams.get("to") ?? ""),
      checkId: u.searchParams.get("checkId"),
    }));
}

function detail(overrides: Partial<ServerDetail> = {}): ServerDetail {
  return {
    id: "s-1",
    name: "Web One",
    hostname: "web-01",
    status: "online",
    sampleIntervalSeconds: 30,
    agentVersion: "1.2.0",
    alertThresholds: { cpuPct: 95, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
    lastSeenAt: "2026-07-13T10:00:00.000Z",
    createdAt: "2026-06-01T10:00:00.000Z",
    projects: [{ id: "p-1", name: "Acme Platform" }],
    checksUp: 1,
    checksDown: 0,
    recentCpu: [10, 20],
    services: [
      { source: "docker", name: "api", state: "running", cpuPct: 12, memBytes: 256 * 1024 * 1024, restarts: null },
      { source: "pm2", name: "worker", state: "errored", cpuPct: null, memBytes: null, restarts: 3 },
    ],
    disks: [{ mount: "/", usedBytes: 40 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }],
    metricsAt: "2026-07-13T10:00:00.000Z",
    ...overrides,
  };
}

function check(overrides: Partial<ServerCheck> = {}): ServerCheck {
  return {
    id: "c-1",
    serverId: "s-1",
    type: "http",
    name: "API health",
    target: "https://api.example.com/health",
    hasDsn: false,
    intervalSeconds: 30,
    enabled: true,
    lastStatus: "up",
    lastCheckedAt: "2026-07-13T10:00:00.000Z",
    lastLatencyMs: 42,
    lastError: null,
    downSince: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

const RAW_METRICS: ServerMetricsResponse = {
  resolution: "raw",
  truncated: false,
  points: [
    {
      ts: "2026-07-13T09:59:00.000Z",
      cpuPct: 20,
      load1m: 0.5,
      memUsedBytes: 2 * 1024 ** 3,
      memTotalBytes: 8 * 1024 ** 3,
      swapUsedBytes: 0,
      diskUsedBytes: 40 * 1024 ** 3,
      diskTotalBytes: 100 * 1024 ** 3,
      netRxBytes: 30_000,
      netTxBytes: 10_000,
    },
    {
      ts: "2026-07-13T10:00:00.000Z",
      cpuPct: 25,
      load1m: 0.6,
      memUsedBytes: 3 * 1024 ** 3,
      memTotalBytes: 8 * 1024 ** 3,
      swapUsedBytes: 0,
      diskUsedBytes: 41 * 1024 ** 3,
      diskTotalBytes: 100 * 1024 ** 3,
      netRxBytes: 60_000,
      netTxBytes: 20_000,
    },
  ],
};

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

/** Handler standard con dettaglio/check/metriche personalizzabili. */
function standardApi(opts: {
  server?: ServerDetail;
  checks?: ServerCheck[];
  metrics?: ServerMetricsResponse;
  onPatch?: (body: unknown) => Response;
} = {}) {
  const server = opts.server ?? detail();
  mockApi({
    "GET /api/auth/me": meHandler(),
    "GET /api/servers/s-1": () => jsonResponse(200, server),
    "GET /api/servers/s-1/checks": () => jsonResponse(200, opts.checks ?? [check()]),
    "GET /api/servers/s-1/metrics": (url) => {
      const metrics = opts.metrics ?? RAW_METRICS;
      // Se la query chiede un checkId, aggiunge la serie di latenza.
      if (url.searchParams.get("checkId") && metrics.resolution === "raw") {
        return jsonResponse(200, {
          ...metrics,
          checkPoints: [
            { ts: "2026-07-13T09:59:00.000Z", status: "up", latencyMs: 40 },
            { ts: "2026-07-13T10:00:00.000Z", status: "up", latencyMs: 45 },
          ],
        });
      }
      return jsonResponse(200, metrics);
    },
    "PATCH /api/servers/s-1": (_url, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return opts.onPatch ? opts.onPatch(body) : jsonResponse(200, server);
    },
  });
}

describe("dettaglio server — Monitor", () => {
  it("mostra header con stato e nota di dati stantii quando il campione è vecchio", async () => {
    // metricsAt di 10 minuti fa, sampleInterval 30s → stantio (> 2×30s).
    const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    standardApi({ server: detail({ metricsAt: staleAt, lastSeenAt: staleAt }) });

    renderApp("/monitor/servers/s-1");

    expect(await screen.findByRole("heading", { name: "Web One" })).toBeInTheDocument();
    expect(screen.getByText("web-01")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("agent 1.2.0")).toBeInTheDocument();
    expect(screen.getByText("Acme Platform")).toBeInTheDocument();
    // Nota dati stantii visibile.
    expect(screen.getByText(/data may be stale/i)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/monitor:/);
  });

  it("non mostra la nota stantii con un campione fresco", async () => {
    const freshAt = new Date(Date.now() - 5 * 1000).toISOString();
    standardApi({ server: detail({ metricsAt: freshAt, lastSeenAt: freshAt }) });

    renderApp("/monitor/servers/s-1");

    await screen.findByRole("heading", { name: "Web One" });
    expect(screen.queryByText(/data may be stale/i)).not.toBeInTheDocument();
  });

  it("il selettore di range cambia from/to nella query metriche (to quantizzato al minuto)", async () => {
    standardApi();

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    // Default 24h.
    await waitFor(() => {
      const last = metricsRanges().at(-1);
      expect(last).toBeDefined();
      expect(last!.to - last!.from).toBe(24 * 60 * 60 * 1000);
      // `to` quantizzato al minuto: nessun resto di secondi/millisecondi.
      expect(last!.to % 60_000).toBe(0);
    });

    // Click su "1h": nuova query con finestra di un'ora.
    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    await waitFor(() => {
      const last = metricsRanges().at(-1);
      expect(last!.to - last!.from).toBe(60 * 60 * 1000);
    });
  });

  it("mostra la nota discreta quando la serie è truncated", async () => {
    standardApi({ metrics: { ...RAW_METRICS, truncated: true } });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    expect(await screen.findByText(/trimmed to the 6000 most recent/i)).toBeInTheDocument();
  });

  it("tabella servizi con badge di sorgente e stati colorati", async () => {
    standardApi();

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    const servicesTable = screen.getByText("Services").closest("section")!;
    const scope = within(servicesTable);
    expect(scope.getByText("api")).toBeInTheDocument();
    expect(scope.getByText("docker")).toBeInTheDocument();
    expect(scope.getByText("worker")).toBeInTheDocument();
    expect(scope.getByText("pm2")).toBeInTheDocument();
    // Riavvii PM2 mostrati.
    expect(scope.getByText(/3 restarts/)).toBeInTheDocument();
  });

  it("tabella check: DSN mai renderizzato e check down evidenziato", async () => {
    const dsnCheck = check({
      id: "c-db",
      type: "postgres",
      name: "Primary DB",
      target: "", // il server non espone mai il DSN
      hasDsn: true,
      lastStatus: "down",
      lastLatencyMs: null,
      lastError: "connection refused",
      downSince: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    standardApi({ checks: [dsnCheck] });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    const checksTable = screen.getByText("Checks").closest("section")!;
    const scope = within(checksTable);
    // L'etichetta cifrata è presente, il DSN in chiaro non compare mai.
    expect(scope.getByText("encrypted DSN")).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/postgres:\/\//);
    // Stato Down + riga con accento d'allarme.
    const downCell = scope.getByText("Down");
    expect(downCell).toBeInTheDocument();
    const row = downCell.closest("tr")!;
    expect(row.className).toContain("border-l-danger");
    expect(scope.getByText("connection refused")).toBeInTheDocument();
  });

  it("selezionando un check aggiunge checkId alla query metriche", async () => {
    standardApi();

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    fireEvent.click(screen.getByText("API health"));
    await waitFor(() => {
      expect(metricsRanges().some((r) => r.checkId === "c-1")).toBe(true);
    });
    // Pannello latenza del check selezionato.
    expect(await screen.findByText(/Latency — API health/)).toBeInTheDocument();
  });

  it("il form soglie invia l'oggetto COMPLETO (full-replacement)", async () => {
    let patchedBody: unknown = null;
    standardApi({
      onPatch: (body) => {
        patchedBody = body;
        return jsonResponse(200, detail({ alertThresholds: (body as { alertThresholds: never }).alertThresholds }));
      },
    });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    // Cambia solo la CPU; il PATCH deve comunque contenere l'oggetto completo.
    fireEvent.change(screen.getByRole("spinbutton", { name: "CPU %" }), {
      target: { value: "80" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save thresholds" }));

    await waitFor(() => expect(patchedBody).not.toBeNull());
    expect(patchedBody).toEqual({
      alertThresholds: { cpuPct: 80, memPct: 90, diskPct: 90, sustainedMinutes: 5 },
    });
    expect(await screen.findByText("Thresholds saved")).toBeInTheDocument();
  });
});
