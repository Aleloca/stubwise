import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectListItem, ServerCheck, ServerView, ServerWithKey } from "../../lib/api";
import { SettingsServersPage } from "./servers";

/**
 * Sotto-pagina Impostazioni → Server (solo admin): lista, registrazione con
 * comando d'installazione (chiave one-shot), rigenerazione chiave ed editor dei
 * check. La rete è mockata via `fetch` globale (come settings.test): le
 * queryOptions catturano i fetcher all'import, quindi spiare il modulo non
 * basterebbe.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
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

function makeServer(overrides: Partial<ServerView> = {}): ServerView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "web-prod-01",
    hostname: "web-01.internal",
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

function makeServerWithKey(overrides: Partial<ServerWithKey> = {}): ServerWithKey {
  return { ...makeServer(), key: "sk_secret_key_value", ...overrides };
}

function makeProject(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Acme",
    slug: "acme",
    description: null,
    aiProviderId: null,
    docAutoUpdate: false,
    ingestionKey: "ik_x",
    nextTicketNumber: 1,
    createdAt: "2026-06-01T10:00:00.000Z",
    repositoryCount: 2,
    ...overrides,
  };
}

function makeCheck(overrides: Partial<ServerCheck> = {}): ServerCheck {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    serverId: "11111111-1111-4111-8111-111111111111",
    type: "http",
    name: "API health",
    target: "https://api.internal/health",
    hasDsn: false,
    intervalSeconds: 60,
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

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsServersPage />
    </QueryClientProvider>,
  );
}

describe("SettingsServersPage — lista", () => {
  it("mostra i server con nome, hostname, stato e azioni", async () => {
    mockApi({
      "GET /api/servers": () =>
        jsonResponse(200, [
          makeServer({ projects: [{ id: "p1", name: "Acme" }] }),
          makeServer({
            id: "22222222-2222-4222-8222-222222222222",
            name: "db-prod",
            hostname: null,
            status: "never_connected",
          }),
        ]),
      "GET /api/projects": () => jsonResponse(200, [makeProject()]),
    });

    renderPage();

    expect(await screen.findByText("web-prod-01")).toBeInTheDocument();
    expect(screen.getByText("web-01.internal")).toBeInTheDocument();
    expect(screen.getByText("db-prod")).toBeInTheDocument();
    // Server mai connesso: etichetta stato "Never connected".
    expect(screen.getAllByText(/never connected/i).length).toBeGreaterThan(0);
    // Azioni presenti su una riga.
    const row = (await screen.findByText("web-prod-01")).closest("li") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Regenerate key" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("senza server mostra il vuoto", async () => {
    mockApi({
      "GET /api/servers": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
    });
    renderPage();
    expect(await screen.findByText(/no servers registered/i)).toBeInTheDocument();
  });
});

describe("SettingsServersPage — registrazione", () => {
  it("crea un server e mostra il comando docker con la chiave e l'avviso one-shot", async () => {
    const user = userEvent.setup();
    let postBody: unknown;
    mockApi({
      "GET /api/servers": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "POST /api/servers": (_url, init) => {
        postBody = JSON.parse(String(init?.body));
        return jsonResponse(201, makeServerWithKey());
      },
    });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "New server" }));
    await user.type(screen.getByLabelText("Name"), "web-prod-01");
    await user.click(screen.getByRole("button", { name: "Register server" }));

    // Sidepanel con il comando docker run: contiene la chiave in chiaro e l'URL.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/sk_secret_key_value/)).toBeInTheDocument();
    expect(within(dialog).getByText(/docker run -d --name stubwise-agent/)).toBeInTheDocument();
    // L'immagine pubblicata su Docker Hub (pull senza clonare il repo).
    expect(within(dialog).getByText(/alelocadev\/stubwise-agent/)).toBeInTheDocument();
    expect(within(dialog).getByText(/STUBWISE_SERVER_KEY=sk_secret_key_value/)).toBeInTheDocument();
    // Avviso "mostrata una sola volta".
    expect(within(dialog).getByText(/shown only once/i)).toBeInTheDocument();
    // Link alla guida completa: naviga fuori dalla SPA (anchor, non router Link).
    expect(within(dialog).getByRole("link", { name: /full guide/i })).toHaveAttribute(
      "href",
      "/guide/monitoring/agent-install/",
    );

    await waitFor(() => expect(postBody).toEqual({ name: "web-prod-01" }));
  });

  it("il sidepanel chiude col bottone Close ma NON cliccando il backdrop", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/servers": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "POST /api/servers": () => jsonResponse(201, makeServerWithKey()),
    });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "New server" }));
    await user.type(screen.getByLabelText("Name"), "web-prod-01");
    await user.click(screen.getByRole("button", { name: "Register server" }));

    await screen.findByRole("dialog");

    // Click sul backdrop: la chiave è irreversibile, il pannello NON deve chiudersi.
    const backdrop = document.querySelector("[data-drawer-backdrop]");
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Il bottone Close chiude: la chiave sparisce dal DOM.
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText(/sk_secret_key_value/)).not.toBeInTheDocument());
  });

  it("senza Clipboard API niente falso 'Copiato': hint di copia manuale", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/servers": () => jsonResponse(200, []),
      "GET /api/projects": () => jsonResponse(200, []),
      "POST /api/servers": () => jsonResponse(201, makeServerWithKey()),
    });

    renderPage();

    await user.click(await screen.findByRole("button", { name: "New server" }));
    await user.type(screen.getByLabelText("Name"), "web-prod-01");
    await user.click(screen.getByRole("button", { name: "Register server" }));

    const dialog = await screen.findByRole("dialog");

    // Contesto non sicuro (http self-hosted): navigator.clipboard è undefined.
    const original = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      await user.click(within(dialog).getByRole("button", { name: "Copy command" }));
      // MAI "Copied" senza copia realmente avvenuta: hint manuale al suo posto.
      expect(within(dialog).getByText(/copy it manually/i)).toBeInTheDocument();
      expect(within(dialog).queryByText("Copied")).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: original, configurable: true });
    }
  });

  it("la rigenerazione chiave mostra di nuovo il comando con la nuova chiave", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/servers": () => jsonResponse(200, [makeServer()]),
      "GET /api/projects": () => jsonResponse(200, []),
      "POST /api/servers/11111111-1111-4111-8111-111111111111/regenerate-key": () =>
        jsonResponse(200, makeServerWithKey({ key: "sk_rotated_key" })),
    });

    renderPage();

    const row = (await screen.findByText("web-prod-01")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Regenerate key" }));
    // Conferma richiesta.
    await user.click(within(row).getByRole("button", { name: "Confirm" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/STUBWISE_SERVER_KEY=sk_rotated_key/)).toBeInTheDocument();
    expect(within(dialog).getByText(/shown only once/i)).toBeInTheDocument();
  });
});

describe("SettingsServersPage — editor check", () => {
  it("il form di un check DB mostra la nota di cifratura e invia il target come DSN", async () => {
    const user = userEvent.setup();
    let checkBody: unknown;
    mockApi({
      "GET /api/servers": () => jsonResponse(200, [makeServer()]),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/servers/11111111-1111-4111-8111-111111111111/checks": () => jsonResponse(200, []),
      "POST /api/servers/11111111-1111-4111-8111-111111111111/checks": (_url, init) => {
        checkBody = JSON.parse(String(init?.body));
        return jsonResponse(201, makeCheck({ type: "postgres", hasDsn: true, target: "" }));
      },
    });

    renderPage();

    const row = (await screen.findByText("web-prod-01")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Checks" }));
    await user.click(await within(row).findByRole("button", { name: "New check" }));

    // Passa il tipo a postgres → compare la nota di cifratura del DSN.
    await user.selectOptions(within(row).getByLabelText("Type"), "postgres");
    expect(within(row).getByText(/saved encrypted/i)).toBeInTheDocument();

    await user.type(within(row).getByLabelText("Name"), "Primary DB");
    await user.type(
      within(row).getByLabelText("Connection string (DSN)"),
      "postgres://u:p@localhost:5432/app",
    );
    await user.click(within(row).getByRole("button", { name: "Add check" }));

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

  it("edit di un check DB con target vuoto → il PUT OMETTE target (DSN invariato)", async () => {
    const user = userEvent.setup();
    const dbCheck = makeCheck({ type: "postgres", hasDsn: true, target: "", name: "Primary DB" });
    let putBody: unknown;
    mockApi({
      "GET /api/servers": () => jsonResponse(200, [makeServer()]),
      "GET /api/projects": () => jsonResponse(200, []),
      "GET /api/servers/11111111-1111-4111-8111-111111111111/checks": () =>
        jsonResponse(200, [dbCheck]),
      [`PUT /api/servers/11111111-1111-4111-8111-111111111111/checks/${dbCheck.id}`]: (
        _url,
        init,
      ) => {
        putBody = JSON.parse(String(init?.body));
        return jsonResponse(200, dbCheck);
      },
    });

    renderPage();

    const row = (await screen.findByText("web-prod-01")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Checks" }));
    const checkItem = (await within(row).findByText("Primary DB")).closest("li") as HTMLElement;
    await user.click(within(checkItem).getByRole("button", { name: "Edit" }));

    // Il campo DSN parte vuoto con la nota "lascia vuoto per mantenere".
    expect(within(checkItem).getByLabelText("Connection string (DSN)")).toHaveValue("");
    expect(within(checkItem).getByText(/leave empty to keep/i)).toBeInTheDocument();

    await user.click(within(checkItem).getByRole("button", { name: "Save check" }));

    // Contratto PUT: target ASSENTE = DSN invariato.
    await waitFor(() =>
      expect(putBody).toEqual({
        type: "postgres",
        name: "Primary DB",
        intervalSeconds: 60,
        enabled: true,
      }),
    );
    expect(putBody).not.toHaveProperty("target");
  });
});

describe("SettingsServersPage — eliminazione server", () => {
  it("cancel non chiama la DELETE; conferma sì", async () => {
    const user = userEvent.setup();
    let deleteCalls = 0;
    mockApi({
      "GET /api/servers": () => jsonResponse(200, [makeServer()]),
      "GET /api/projects": () => jsonResponse(200, []),
      "DELETE /api/servers/11111111-1111-4111-8111-111111111111": () => {
        deleteCalls += 1;
        return jsonResponse(204, null);
      },
    });

    renderPage();

    const row = (await screen.findByText("web-prod-01")).closest("li") as HTMLElement;

    // Cancel: l'avviso compare ma nessuna DELETE parte.
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    expect(within(row).getByText(/permanently deleted/i)).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(deleteCalls).toBe(0);

    // Conferma: DELETE chiamata una volta.
    await user.click(within(row).getByRole("button", { name: "Delete" }));
    await user.click(within(row).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(deleteCalls).toBe(1));
  });
});

describe("SettingsServersPage — modifica server", () => {
  it("il PATCH include i projectIds selezionati", async () => {
    const user = userEvent.setup();
    const beta = makeProject({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Beta",
      slug: "beta",
    });
    let patchBody: unknown;
    mockApi({
      "GET /api/servers": () => jsonResponse(200, [makeServer()]),
      "GET /api/projects": () => jsonResponse(200, [makeProject(), beta]),
      "PATCH /api/servers/11111111-1111-4111-8111-111111111111": (_url, init) => {
        patchBody = JSON.parse(String(init?.body));
        return jsonResponse(200, makeServer());
      },
    });

    renderPage();

    const row = (await screen.findByText("web-prod-01")).closest("li") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Edit" }));

    // Seleziona il progetto "Beta" nel multi-select a checkbox.
    await user.click(within(row).getByRole("checkbox", { name: "Beta" }));
    await user.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchBody).toEqual({
        name: "web-prod-01",
        sampleIntervalSeconds: 30,
        projectIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      }),
    );
  });
});
