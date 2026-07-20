import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BacklogItemDetail } from "../../lib/api";
import { createAppRouter } from "../../router";
import { setMatchMedia } from "../../test/setup";

/** Breakpoint `lg`: sopra la chat è un pannello inline (non un drawer). */
const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * Test del dettaglio backlog col router vero (memory history) e fetch mockata
 * per metodo+path: la voce vive in uno stato mutabile, così PATCH/accept/
 * dismiss/convert/merge/deep-dive diventano richieste reali sul mock. Il default
 * matchMedia è mobile → la chat è un drawer chiuso e non interferisce.
 */

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TICKET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REPO_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REPO_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function detailFixture(overrides: Partial<BacklogItemDetail> = {}): BacklogItemDetail {
  return {
    id: ITEM_ID,
    projectId: PROJECT_ID,
    title: "Export massivo ordini",
    document: "Serve un **export CSV** degli ordini.",
    status: "refining",
    effort: 2,
    risk: "low",
    riskNote: null,
    urgency: "medium",
    requestCount: 3,
    source: "manual",
    suggested: null,
    similarTo: null,
    tickets: [],
    messages: [],
    deepDivePending: false,
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    ...overrides,
  };
}

function projectsFixture() {
  return [
    {
      id: PROJECT_ID,
      name: "Progetto Alfa",
      slug: "progetto-alfa",
      description: null,
      aiProviderId: null,
      docAutoUpdate: false,
      dailyReportEnabled: false,
      backlogEnabled: true,
      ingestionKey: "key-alfa",
      nextTicketNumber: 1,
      repositoryCount: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

interface MockState {
  item: BacklogItemDetail;
  patches: unknown[];
  accepts: number;
  dismisses: number;
  refreshes: number;
  deepDives: unknown[];
  converts: number;
  merges: unknown[];
  /** Esito da far tornare al refresh-document (default 200). */
  refreshStatus: number;
  /** Esito da far tornare al deep-dive (default 202; 409 = già in corso). */
  deepDiveStatus: number;
}

function mockDetailApi(
  overrides: {
    item?: BacklogItemDetail;
    role?: "admin" | "member";
    repos?: unknown[];
    refreshStatus?: number;
    deepDiveStatus?: number;
  } = {},
): MockState {
  const state: MockState = {
    item: overrides.item ?? detailFixture(),
    patches: [],
    accepts: 0,
    dismisses: 0,
    refreshes: 0,
    deepDives: [],
    converts: 0,
    merges: [],
    refreshStatus: overrides.refreshStatus ?? 200,
    deepDiveStatus: overrides.deepDiveStatus ?? 202,
  };
  const role = overrides.role ?? "admin";
  const repos =
    overrides.repos ??
    [
      { id: REPO_A, name: "Repo A", slug: "repo-a", projectId: PROJECT_ID, provider: "github" },
      { id: REPO_B, name: "Repo B", slug: "repo-b", projectId: PROJECT_ID, provider: "github" },
    ];

  /** La forma BASE della voce (senza tickets/messages/deepDivePending). */
  const base = () => {
    const rest: Partial<BacklogItemDetail> = { ...state.item };
    delete rest.tickets;
    delete rest.messages;
    delete rest.deepDivePending;
    return rest;
  };

  fetchMock.mockImplementation((input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://test.local");
    const method = init?.method ?? "GET";
    const path = url.pathname;

    if (path === "/api/auth/me") {
      return Promise.resolve(
        jsonResponse(200, {
          user: { id: "u1", email: "ada@example.com", role, avatarUrl: null, slackUserId: null },
        }),
      );
    }
    if (path === "/api/projects") return Promise.resolve(jsonResponse(200, projectsFixture()));
    if (path === "/api/repositories") return Promise.resolve(jsonResponse(200, repos));

    // Lista (candidati fusione): esclude la corrente lato client.
    if (path === "/api/backlog" && method === "GET") {
      return Promise.resolve(
        jsonResponse(200, {
          items: [
            {
              id: TARGET_ID,
              projectId: PROJECT_ID,
              title: "Report ordini",
              status: "new",
              effort: null,
              risk: null,
              riskNote: null,
              urgency: null,
              requestCount: 1,
              source: "manual",
              similarTo: null,
              ticketCount: 0,
              createdAt: "2026-06-01T10:00:00.000Z",
              updatedAt: "2026-06-01T10:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
      );
    }

    const detailMatch = path.match(/^\/api\/backlog\/([^/]+)$/);
    if (detailMatch && method === "GET") {
      const id = detailMatch[1]!;
      if (id === ITEM_ID) return Promise.resolve(jsonResponse(200, state.item));
      // Destinazione della fusione: dettaglio minimale valido.
      return Promise.resolve(jsonResponse(200, detailFixture({ id, title: "Report ordini" })));
    }
    if (detailMatch && method === "PATCH") {
      const patch = JSON.parse(String(init?.body)) as Partial<BacklogItemDetail>;
      state.patches.push(patch);
      state.item = { ...state.item, ...patch };
      return Promise.resolve(jsonResponse(200, base()));
    }

    if (path === `/api/backlog/${ITEM_ID}/suggested/accept`) {
      state.accepts += 1;
      const s = state.item.suggested;
      if (s) {
        state.item = {
          ...state.item,
          effort: s.effort ?? state.item.effort,
          risk: s.risk ?? state.item.risk,
          riskNote: s.riskNote ?? state.item.riskNote,
          urgency: s.urgency ?? state.item.urgency,
          suggested: null,
        };
      }
      return Promise.resolve(jsonResponse(200, base()));
    }
    if (path === `/api/backlog/${ITEM_ID}/suggested/dismiss`) {
      state.dismisses += 1;
      state.item = { ...state.item, suggested: null };
      return Promise.resolve(jsonResponse(200, base()));
    }
    if (path === `/api/backlog/${ITEM_ID}/refresh-document`) {
      state.refreshes += 1;
      if (state.refreshStatus !== 200) {
        return Promise.resolve(
          jsonResponse(state.refreshStatus, {
            code: state.refreshStatus === 409 ? "nothing_new" : "generation_failed",
            message: "refresh error",
          }),
        );
      }
      state.item = { ...state.item, document: "Documento aggiornato." };
      return Promise.resolve(jsonResponse(200, base()));
    }
    if (path === `/api/backlog/${ITEM_ID}/deep-dive`) {
      if (state.deepDiveStatus !== 202) {
        return Promise.resolve(
          jsonResponse(state.deepDiveStatus, {
            code: "deep_dive_pending",
            message: "A deep dive is already in progress",
          }),
        );
      }
      state.deepDives.push(JSON.parse(String(init?.body)));
      state.item = { ...state.item, deepDivePending: true };
      return Promise.resolve(jsonResponse(202, { queued: true }));
    }
    if (path === `/api/backlog/${ITEM_ID}/convert`) {
      state.converts += 1;
      state.item = { ...state.item, status: "converted" };
      return Promise.resolve(jsonResponse(200, { ticketId: TICKET_ID, ticketNumber: 42 }));
    }
    if (path === `/api/backlog/${ITEM_ID}/merge`) {
      state.merges.push(JSON.parse(String(init?.body)));
      return Promise.resolve(jsonResponse(200, base()));
    }

    throw new Error(`fetch non mockata per ${method} ${path}`);
  });

  return state;
}

function renderDetail(initialPath = `/backlog/${ITEM_ID}`) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [initialPath] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

describe("dettaglio backlog", () => {
  it("header: titolo, badge di stato/effort/rischio/urgenza e progetto", async () => {
    mockDetailApi();
    renderDetail();

    expect(await screen.findByRole("heading", { name: "Export massivo ordini" })).toBeInTheDocument();
    const header = screen.getByRole("banner");
    expect(within(header).getByText("Refining")).toBeInTheDocument();
    expect(within(header).getByText("E2")).toBeInTheDocument();
    expect(within(header).getByText("Low risk")).toBeInTheDocument();
    expect(within(header).getByText("Medium")).toBeInTheDocument();
    expect(within(header).getByText("Progetto Alfa")).toBeInTheDocument();
    expect(within(header).getByText("×3")).toBeInTheDocument();
  });

  it("documento reso in markdown", async () => {
    mockDetailApi();
    renderDetail();

    const bold = await screen.findByText("export CSV");
    expect(bold.tagName).toBe("STRONG");
  });

  it("ticket collegati: link al ticket e badge del ruolo", async () => {
    mockDetailApi({
      item: detailFixture({
        tickets: [{ id: TICKET_ID, number: 7, title: "Origine feedback", role: "origin" }],
      }),
    });
    renderDetail();

    const section = await screen.findByRole("region", { name: "Linked tickets" });
    const link = within(section).getByRole("link", { name: /#7.*Origine feedback/ });
    expect(link).toHaveAttribute("href", `/tickets/${TICKET_ID}`);
    expect(within(section).getByText("origin")).toBeInTheDocument();
  });

  it("banner suggeriti: mostra proposto vs attuale e Accetta tutti applica", async () => {
    const state = mockDetailApi({
      item: detailFixture({
        effort: 2,
        suggested: { effort: 4, reason: "Il diff tocca più moduli" },
      }),
    });
    renderDetail();

    const banner = await screen.findByRole("region", { name: "AI suggestions" });
    expect(within(banner).getByText(/effort 4/)).toBeInTheDocument();
    expect(within(banner).getByText(/was 2/)).toBeInTheDocument();
    expect(within(banner).getByText(/Il diff tocca più moduli/)).toBeInTheDocument();

    await userEvent.click(within(banner).getByRole("button", { name: "Accept all" }));

    await waitFor(() => expect(state.accepts).toBe(1));
    // Applicato: il badge effort diventa E4 e il banner sparisce.
    const header = await screen.findByRole("banner");
    await waitFor(() => expect(within(header).getByText("E4")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "AI suggestions" })).not.toBeInTheDocument(),
    );
  });

  it("banner suggeriti: Ignora chiama dismiss e nasconde il banner", async () => {
    const state = mockDetailApi({
      item: detailFixture({ suggested: { risk: "high" } }),
    });
    renderDetail();

    const banner = await screen.findByRole("region", { name: "AI suggestions" });
    await userEvent.click(within(banner).getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(state.dismisses).toBe(1));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "AI suggestions" })).not.toBeInTheDocument(),
    );
  });

  it("cambiare stato dal select manda la PATCH", async () => {
    const state = mockDetailApi();
    renderDetail();

    await userEvent.selectOptions(await screen.findByLabelText("Status"), "ready");
    await waitFor(() => expect(state.patches).toEqual([{ status: "ready" }]));
  });

  it("cambiare effort manda la PATCH con il numero; None manda null", async () => {
    const state = mockDetailApi();
    renderDetail();

    await userEvent.selectOptions(await screen.findByLabelText("Effort"), "E4");
    await waitFor(() => expect(state.patches).toEqual([{ effort: 4 }]));

    await userEvent.selectOptions(screen.getByLabelText("Effort"), "None");
    await waitFor(() => expect(state.patches).toContainEqual({ effort: null }));
  });

  it("avviso di analisi in corso quando deepDivePending", async () => {
    mockDetailApi({ item: detailFixture({ deepDivePending: true }) });
    renderDetail();

    expect(await screen.findByText(/Deep-dive analysis in progress/i)).toBeInTheDocument();
  });

  it("deep dive con un solo repo parte diretto", async () => {
    const state = mockDetailApi({ repos: [{ id: REPO_A, name: "Repo A", slug: "repo-a", projectId: PROJECT_ID, provider: "github" }] });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Deep-dive analysis" }));
    await waitFor(() => expect(state.deepDives).toEqual([{ repositoryId: REPO_A }]));
  });

  it("deep dive con più repo apre la dialog di scelta", async () => {
    const state = mockDetailApi();
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Deep-dive analysis" }));
    const dialog = await screen.findByRole("dialog", { name: /choose a repository/i });
    await userEvent.selectOptions(within(dialog).getByLabelText("Choose a repository"), REPO_B);
    await userEvent.click(within(dialog).getByRole("button", { name: "Start" }));

    await waitFor(() => expect(state.deepDives).toEqual([{ repositoryId: REPO_B }]));
  });

  it("aggiorna documento: 409 mostra il messaggio informativo", async () => {
    mockDetailApi({ refreshStatus: 409 });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Update document" }));
    expect(await screen.findByText(/Nothing new to synthesize/i)).toBeInTheDocument();
  });

  it("aggiorna documento: 502 mostra l'errore di generazione", async () => {
    mockDetailApi({ refreshStatus: 502 });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Update document" }));
    expect(await screen.findByText(/Could not generate the document/i)).toBeInTheDocument();
  });

  it("deep dive: 409 (già in corso) mostra il messaggio d'errore del server", async () => {
    mockDetailApi({
      deepDiveStatus: 409,
      repos: [{ id: REPO_A, name: "Repo A", slug: "repo-a", projectId: PROJECT_ID, provider: "github" }],
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Deep-dive analysis" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already in progress/i);
  });

  it("converti in task: conferma, POST e link al ticket creato", async () => {
    const state = mockDetailApi();
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Convert to task" }));
    const dialog = await screen.findByRole("dialog", { name: /convert to a task/i });
    await userEvent.click(within(dialog).getByRole("button", { name: "Convert" }));

    await waitFor(() => expect(state.converts).toBe(1));
    const link = await screen.findByRole("link", { name: /View ticket #42/ });
    expect(link).toHaveAttribute("href", `/tickets/${TICKET_ID}`);
  });

  it("fondi con…: sceglie un target e naviga alla destinazione", async () => {
    const state = mockDetailApi();
    const { router } = renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Merge into…" }));
    const input = await screen.findByRole("combobox", { name: /search backlog items/i });
    await userEvent.type(input, "report");
    await userEvent.click(await screen.findByRole("option", { name: /Report ordini/ }));

    await waitFor(() => expect(state.merges).toEqual([{ targetId: TARGET_ID }]));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/backlog/${TARGET_ID}`));
  });

  it("archivia: manda la PATCH con status archived", async () => {
    const state = mockDetailApi();
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Archive" }));
    await waitFor(() => expect(state.patches).toEqual([{ status: "archived" }]));
  });

  it("voce convertita: metadati read-only e azioni di modifica nascoste", async () => {
    mockDetailApi({
      item: detailFixture({
        status: "converted",
        tickets: [{ id: TICKET_ID, number: 42, title: "Task convertito", role: "converted_to" }],
      }),
    });
    renderDetail();

    expect(await screen.findByLabelText("Status")).toBeDisabled();
    expect(screen.getByLabelText("Effort")).toBeDisabled();
    // Le azioni di modifica non ci sono; l'export resta.
    expect(screen.queryByRole("button", { name: "Convert to task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update document" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download .md" })).toBeInTheDocument();
    expect(screen.getByText(/This item is Converted/i)).toBeInTheDocument();
  });

  it("voce archiviata: mostra Riapri", async () => {
    const state = mockDetailApi({ item: detailFixture({ status: "archived" }) });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(state.patches).toEqual([{ status: "refining" }]));
  });

  it("esporta .md: copia negli appunti il documento con frontmatter", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mockDetailApi();
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Copy Markdown" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const exported = String(writeText.mock.calls[0]![0]);
    // I valori stringa liberi sono quotati (JSON.stringify): YAML sempre valido.
    expect(exported).toContain('title: "Export massivo ordini"');
    expect(exported).toContain('project: "Progetto Alfa"');
  });

  it("esporta .md: un titolo con ':' resta YAML valido (valore quotato)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mockDetailApi({ item: detailFixture({ title: "Fix: export ordini" }) });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Copy Markdown" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain('title: "Fix: export ordini"');
  });

  it("dopo la fusione la navigazione resetta chat e notice locali (key={id})", async () => {
    // Desktop: la chat è un pannello inline, così la storia è visibile senza
    // aprire il drawer. La voce SORGENTE ha una storia; la destinazione no.
    setMatchMedia(DESKTOP_QUERY, true);
    mockDetailApi({
      refreshStatus: 409,
      item: detailFixture({
        messages: [
          {
            id: "m1",
            role: "user",
            content: "vecchia domanda",
            citations: null,
            createdAt: "2026-06-01T10:00:00.000Z",
          },
        ],
      }),
    });
    const { router } = renderDetail();

    // La chat della sorgente mostra la sua storia.
    expect(await screen.findByText("vecchia domanda")).toBeInTheDocument();

    // Provoca un notice locale nell'ActionsPanel (409 → messaggio informativo).
    await userEvent.click(screen.getByRole("button", { name: "Update document" }));
    expect(await screen.findByText(/Nothing new to synthesize/i)).toBeInTheDocument();

    // Fondi → navigazione alla destinazione (stessa route, id diverso).
    await userEvent.click(screen.getByRole("button", { name: "Merge into…" }));
    const input = await screen.findByRole("combobox", { name: /search backlog items/i });
    await userEvent.type(input, "report");
    await userEvent.click(await screen.findByRole("option", { name: /Report ordini/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/backlog/${TARGET_ID}`));

    // key={id}: chat rimontata con la storia della destinazione (vuota) e
    // ActionsPanel rimontato senza il notice della voce assorbita.
    expect(await screen.findByText(/no messages yet/i)).toBeInTheDocument();
    expect(screen.queryByText("vecchia domanda")).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing new to synthesize/i)).not.toBeInTheDocument();
  });

  it("member: niente banner suggeriti né barra azioni, metadati disabilitati", async () => {
    mockDetailApi({ role: "member", item: detailFixture({ suggested: { effort: 4 } }) });
    renderDetail();

    await screen.findByRole("heading", { name: "Export massivo ordini" });
    expect(screen.queryByRole("region", { name: "AI suggestions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Convert to task" })).not.toBeInTheDocument();
    // I metadati restano visibili ma DISABILITATI: la PATCH server è
    // admin-only e un 403 dal select sarebbe solo confuso.
    expect(screen.getByLabelText("Status")).toBeDisabled();
    expect(screen.getByLabelText("Effort")).toBeDisabled();
    expect(screen.getByLabelText("Risk")).toBeDisabled();
    expect(screen.getByLabelText("Urgency")).toBeDisabled();
    expect(screen.getByLabelText("Risk note")).toBeDisabled();
  });
});
