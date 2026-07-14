import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
// che il wrapper chiama (destroy in cleanup, setSize al resize). Le chiamate al
// costruttore restano ispezionabili: i test 5m verificano opts/data passati.
vi.mock("uplot", () => ({
  default: vi.fn(() => ({ destroy: vi.fn(), setData: vi.fn(), setSize: vi.fn() })),
}));
// Import DOPO vi.mock (che è comunque hoistato): riceve il costruttore mockato.
import UPlot from "uplot";

/** Coppie (opts, data) di ogni istanza uPlot creata. */
function uplotCalls(): { opts: UPlot.Options; data: UPlot.AlignedData }[] {
  return vi
    .mocked(UPlot)
    .mock.calls.map(([opts, data]) => ({ opts, data: data as UPlot.AlignedData }));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(UPlot).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

// Un handler può ritornare una Promise pendente (per fotografare lo stato
// "durante il fetch"); `mockApi` fa comunque `Promise.resolve`.
type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

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

function meHandler(role: "admin" | "member" = "admin"): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role } });
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

// Rollup 5m con numeri "puliti": le somme di rete divise per 300s e 1024 danno
// KB/s interi (3_072_000 → 10, 6_144_000 → 20).
const ROLLUP_METRICS: ServerMetricsResponse = {
  resolution: "5m",
  truncated: false,
  points: [
    {
      ts: "2026-07-13T09:50:00.000Z",
      cpuPctAvg: 20,
      cpuPctMax: 40,
      load1mAvg: 0.5,
      load1mMax: 1.2,
      memUsedBytesAvg: 2 * 1024 ** 3,
      memUsedBytesMax: 3 * 1024 ** 3,
      memTotalBytes: 8 * 1024 ** 3,
      diskUsedBytesAvg: 40 * 1024 ** 3,
      diskUsedBytesMax: 41 * 1024 ** 3,
      diskTotalBytes: 100 * 1024 ** 3,
      netRxBytesSum: 3_072_000,
      netTxBytesSum: 1_536_000,
    },
    {
      ts: "2026-07-13T09:55:00.000Z",
      cpuPctAvg: 30,
      cpuPctMax: 60,
      load1mAvg: 0.8,
      load1mMax: 1.5,
      memUsedBytesAvg: 2 * 1024 ** 3,
      memUsedBytesMax: 3 * 1024 ** 3,
      memTotalBytes: 8 * 1024 ** 3,
      diskUsedBytesAvg: 40 * 1024 ** 3,
      diskUsedBytesMax: 41 * 1024 ** 3,
      diskTotalBytes: 100 * 1024 ** 3,
      netRxBytesSum: 6_144_000,
      netTxBytesSum: 3_072_000,
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
  role?: "admin" | "member";
  projects?: unknown[];
  onPatch?: (body: unknown) => Response;
} = {}) {
  const server = opts.server ?? detail();
  mockApi({
    "GET /api/auth/me": meHandler(opts.role ?? "admin"),
    // Progetti: query secondaria dell'editor anagrafica (pannello admin).
    "GET /api/projects": () => jsonResponse(200, opts.projects ?? []),
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
    // Il progetto associato compare nell'header (badge) e nel pannello
    // impostazioni server (riepilogo admin): almeno una occorrenza.
    expect(screen.getAllByText("Acme Platform").length).toBeGreaterThan(0);
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

  it("cambiando range i grafici restano montati mentre arriva il nuovo dato (niente flicker)", async () => {
    let metricsCalls = 0;
    let resolveSecond!: (r: Response) => void;
    const secondPending = new Promise<Response>((res) => {
      resolveSecond = res;
    });
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/servers/s-1": () => jsonResponse(200, detail()),
      "GET /api/servers/s-1/checks": () => jsonResponse(200, [check()]),
      "GET /api/servers/s-1/metrics": () => {
        metricsCalls += 1;
        // 1ª query (24h) risolve subito; la 2ª (nuovo range) resta pendente, per
        // fotografare lo stato "durante il fetch della nuova chiave".
        return metricsCalls === 1 ? jsonResponse(200, RAW_METRICS) : secondPending;
      },
    });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });
    // Grafici montati: il wrapper rende un div role="img" per pannello.
    await waitFor(() => expect(screen.getAllByRole("img").length).toBeGreaterThan(0));
    const mounted = screen.getAllByRole("img").length;

    // Cambio range → seconda query metriche, lasciata pendente.
    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    await waitFor(() => expect(metricsCalls).toBe(2));

    // REGRESSIONE: senza `placeholderData: keepPreviousData` il `data` della
    // query diventa undefined durante il fetch → il ternario smonta i pannelli
    // (sostituiti da "loading") → sfarfallio. Con keepPreviousData i dati
    // precedenti restano e i grafici non spariscono.
    expect(screen.queryAllByRole("img")).toHaveLength(mounted);

    resolveSecond(jsonResponse(200, RAW_METRICS));
  });

  it("mostra la nota discreta quando la serie è truncated", async () => {
    standardApi({ metrics: { ...RAW_METRICS, truncated: true } });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    // La nota non promette un numero: il tetto è un dettaglio del server.
    expect(await screen.findByText(/trimmed to the most recent points/i)).toBeInTheDocument();
  });

  it("response 5m: avg/max nei pannelli, load su scala dedicata e rete divisa per 300s", async () => {
    standardApi({ metrics: ROLLUP_METRICS });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    // 4 pannelli montati (istanze uPlot create dal wrapper mockato).
    await waitFor(() => expect(uplotCalls().length).toBeGreaterThanOrEqual(4));
    const calls = uplotCalls();

    // Pannello CPU: serie avg + max + load; il load vive sulla scala dedicata.
    const cpu = calls.find((c) => c.opts.series[2]?.label === "CPU % max");
    expect(cpu).toBeDefined();
    expect(cpu!.data[1]).toEqual([20, 30]); // cpuPctAvg
    expect(cpu!.data[2]).toEqual([40, 60]); // cpuPctMax
    expect(cpu!.opts.series[3]?.label).toBe("Load 1m");
    expect(cpu!.opts.series[3]?.scale).toBe("load");
    expect(cpu!.data[3]).toEqual([0.5, 0.8]); // load1mAvg

    // Pannello rete: somme sul bucket / 300s / 1024 → KB/s medi.
    const net = calls.find((c) => c.opts.series[1]?.label === "In");
    expect(net).toBeDefined();
    expect(net!.data[1]).toEqual([10, 20]); // netRxBytesSum
    expect(net!.data[2]).toEqual([5, 10]); // netTxBytesSum
  });

  it("points vuoti → empty state nei pannelli, nessuna istanza uPlot", async () => {
    standardApi({ metrics: { resolution: "raw", truncated: false, points: [] } });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    expect(await screen.findAllByText("// no samples in this range")).toHaveLength(4);
    expect(vi.mocked(UPlot)).not.toHaveBeenCalled();
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

describe("dettaglio server — gestione (admin vs member)", () => {
  it("member: nessun controllo di gestione (check e server in sola lettura)", async () => {
    standardApi({ role: "member" });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    // Nessun editor check né pannello impostazioni server.
    expect(screen.queryByRole("button", { name: "New check" })).not.toBeInTheDocument();
    expect(screen.queryByText("Server settings")).not.toBeInTheDocument();
    // La riga check non espone azioni di modifica/elimina.
    const row = screen.getByText("API health").closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    // Ma la selezione per il grafico latenza resta disponibile a tutti.
    fireEvent.click(screen.getByText("API health"));
    await waitFor(() => expect(metricsRanges().some((r) => r.checkId === "c-1")).toBe(true));
  });

  it("admin: aggiunge un check DB dal sidepanel (target inviato come DSN)", async () => {
    const user = userEvent.setup();
    let checkBody: unknown;
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/servers/s-1": () => jsonResponse(200, detail()),
      "GET /api/servers/s-1/checks": () => jsonResponse(200, []),
      "GET /api/servers/s-1/metrics": () => jsonResponse(200, RAW_METRICS),
      "POST /api/servers/s-1/checks": (_url, init) => {
        checkBody = JSON.parse(String(init?.body));
        return jsonResponse(201, check({ type: "postgres", hasDsn: true, target: "" }));
      },
    });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    await user.click(screen.getByRole("button", { name: "New check" }));
    const dialog = await screen.findByRole("dialog");

    // Tipo postgres → nota di cifratura del DSN.
    await user.selectOptions(within(dialog).getByLabelText("Type"), "postgres");
    expect(within(dialog).getByText(/saved encrypted/i)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Name"), "Primary DB");
    await user.type(
      within(dialog).getByLabelText("Connection string (DSN)"),
      "postgres://u:p@localhost:5432/app",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add check" }));

    await waitFor(() =>
      expect(checkBody).toEqual({
        type: "postgres",
        name: "Primary DB",
        target: "postgres://u:p@localhost:5432/app",
        intervalSeconds: 60,
        enabled: true,
      }),
    );
  });

  it("admin: edit di un check DB con target vuoto → il PUT OMETTE target", async () => {
    const user = userEvent.setup();
    const dbCheck = check({ type: "postgres", hasDsn: true, target: "", name: "Primary DB" });
    let putBody: unknown;
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/servers/s-1": () => jsonResponse(200, detail()),
      "GET /api/servers/s-1/checks": () => jsonResponse(200, [dbCheck]),
      "GET /api/servers/s-1/metrics": () => jsonResponse(200, RAW_METRICS),
      [`PUT /api/servers/s-1/checks/${dbCheck.id}`]: (_url, init) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, dbCheck);
      },
    });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    const row = screen.getByText("Primary DB").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Edit" }));

    const dialog = await screen.findByRole("dialog");
    // Campo DSN vuoto con la nota "lascia vuoto per mantenere".
    expect(within(dialog).getByLabelText("Connection string (DSN)")).toHaveValue("");
    expect(within(dialog).getByText(/leave empty to keep/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save check" }));

    await waitFor(() =>
      expect(putBody).toEqual({
        type: "postgres",
        name: "Primary DB",
        intervalSeconds: 30,
        enabled: true,
      }),
    );
    expect(putBody).not.toHaveProperty("target");
  });

  it("admin: elimina un check con conferma", async () => {
    const user = userEvent.setup();
    let deleteCalls = 0;
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/servers/s-1": () => jsonResponse(200, detail()),
      "GET /api/servers/s-1/checks": () => jsonResponse(200, [check()]),
      "GET /api/servers/s-1/metrics": () => jsonResponse(200, RAW_METRICS),
      "DELETE /api/servers/s-1/checks/c-1": () => {
        deleteCalls += 1;
        return jsonResponse(204, null);
      },
    });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    const row = screen.getByText("API health").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    // Conferma richiesta prima della DELETE.
    await user.click(within(row).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(deleteCalls).toBe(1));
  });

  it("admin: il PATCH del server include i projectIds selezionati", async () => {
    const user = userEvent.setup();
    let patchBody: unknown;
    standardApi({
      projects: [
        { id: "p-1", name: "Acme Platform", slug: "acme" },
        { id: "p-2", name: "Beta", slug: "beta" },
      ],
      onPatch: (body) => {
        patchBody = body;
        return jsonResponse(200, detail());
      },
    });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    const panel = screen.getByText("Server settings").closest("section")!;
    await user.click(within(panel).getByRole("button", { name: "Edit" }));
    // Aggiunge "Beta" al server (già associato ad Acme Platform).
    await user.click(within(panel).getByRole("checkbox", { name: "Beta" }));
    await user.click(within(panel).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchBody).toEqual({
        name: "Web One",
        sampleIntervalSeconds: 30,
        projectIds: ["p-1", "p-2"],
      }),
    );
  });

  it("admin: rigenera la chiave e riapre il sidepanel guida con la nuova chiave", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/servers/s-1": () => jsonResponse(200, detail()),
      "GET /api/servers/s-1/checks": () => jsonResponse(200, [check()]),
      "GET /api/servers/s-1/metrics": () => jsonResponse(200, RAW_METRICS),
      "POST /api/servers/s-1/regenerate-key": () =>
        jsonResponse(200, { ...detail(), key: "sk_rotated_key" }),
    });

    renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    const panel = screen.getByText("Server settings").closest("section")!;
    await user.click(within(panel).getByRole("button", { name: "Regenerate key" }));
    await user.click(within(panel).getByRole("button", { name: "Confirm" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/STUBWISE_SERVER_KEY=sk_rotated_key/)).toBeInTheDocument();
    expect(within(dialog).getByText(/shown only once/i)).toBeInTheDocument();
  });

  it("admin: elimina il server con conferma → redirect al Monitor", async () => {
    const user = userEvent.setup();
    let deleteCalls = 0;
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/servers/s-1": () => jsonResponse(200, detail()),
      "GET /api/servers/s-1/checks": () => jsonResponse(200, [check()]),
      "GET /api/servers/s-1/metrics": () => jsonResponse(200, RAW_METRICS),
      "DELETE /api/servers/s-1": () => {
        deleteCalls += 1;
        return jsonResponse(204, null);
      },
      // Dopo il redirect il Monitor carica la lista (vuota qui).
      "GET /api/servers": () => jsonResponse(200, []),
    });

    const router = renderApp("/monitor/servers/s-1");
    await screen.findByRole("heading", { name: "Web One" });

    const panel = screen.getByText("Server settings").closest("section")!;
    await user.click(within(panel).getByRole("button", { name: "Delete" }));
    await user.click(within(panel).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(deleteCalls).toBe(1));
    // Redirect alla lista Monitor.
    await waitFor(() => expect(router.state.location.pathname).toBe("/monitor"));
  });
});
