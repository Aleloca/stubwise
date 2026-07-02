import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocPage, DocTreeNode } from "../lib/docs-api";
import { createAppRouter } from "../router";
import { setMatchMedia } from "../test/setup";

/**
 * Spazio Docs — editing pagine manuali (M7.3) + trigger/stato generazione e
 * ricerca (M7.4). Router vero (memory history), fetch mockata a livello di rete.
 */

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MANUAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
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

function meHandler(role: "admin" | "member"): Handler {
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role } });
}

function node(
  overrides: Partial<DocTreeNode> & Pick<DocTreeNode, "id" | "slug" | "title" | "kind">,
): DocTreeNode {
  return {
    parentId: null,
    position: 0,
    sourcePath: null,
    isManual: overrides.kind === "manual",
    ...overrides,
  };
}

const TREE: DocTreeNode[] = [
  node({ id: "t1", slug: "tech-overview", title: "Technical overview", kind: "technical" }),
  node({ id: MANUAL_ID, slug: "guide", title: "Guide", kind: "manual" }),
];

function makePage(overrides: Partial<DocPage> & Pick<DocPage, "slug" | "title" | "kind">): DocPage {
  return {
    id: overrides.slug,
    parentId: null,
    position: 0,
    sourcePath: null,
    body: `# ${overrides.title}\n\nBody.`,
    isManual: overrides.kind === "manual",
    commitSha: null,
    updatedAt: "2026-06-20T10:00:00.000Z",
    ...overrides,
  };
}

const MANUAL_PAGE = makePage({
  id: MANUAL_ID,
  slug: "guide",
  title: "Guide",
  kind: "manual",
  body: "# Guide\n\nManual content.",
});

const TECH_PAGE = makePage({
  id: "tech-overview",
  slug: "tech-overview",
  title: "Technical overview",
  kind: "technical",
  commitSha: "abc1234def",
  body: "# Technical overview\n\nGenerated.",
});

/** Handler comuni (tree + status null + pagine), parametrizzati sul ruolo. */
function baseHandlers(role: "admin" | "member" = "member"): Record<string, Handler> {
  return {
    "GET /api/auth/me": meHandler(role),
    [`GET /api/repositories/${PROJECT_ID}/docs/tree`]: () => jsonResponse(200, TREE),
    [`GET /api/repositories/${PROJECT_ID}/docs/status`]: () =>
      jsonResponse(200, { generation: null, latestJob: null, pinnedProvider: null }),
    [`GET /api/ai-providers`]: () => jsonResponse(200, []),
    [`GET /api/repositories/${PROJECT_ID}/docs/pages/guide`]: () => jsonResponse(200, MANUAL_PAGE),
    [`GET /api/repositories/${PROJECT_ID}/docs/pages/tech-overview`]: () =>
      jsonResponse(200, TECH_PAGE),
  };
}

function renderApp(initialPath: string) {
  // Viewport desktop: la sidebar Docs (albero + pannello generazione) è un aside
  // fisso sempre montato, non un drawer chiuso. Sotto `lg` quei controlli vivono
  // nel drawer "Indice" (testato in docs-space.test.tsx).
  setMatchMedia("(min-width: 1024px)", true);
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

describe("editing pagine manuali (M7.3)", () => {
  it("crea una pagina manuale e naviga alla pagina creata", async () => {
    const created = makePage({ id: MANUAL_ID, slug: "guide", title: "Guide", kind: "manual" });
    let posted: unknown = null;
    mockApi({
      ...baseHandlers(),
      [`POST /api/repositories/${PROJECT_ID}/docs/manual`]: (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return jsonResponse(201, created);
      },
    });
    renderApp(`/docs/${PROJECT_ID}/new`);

    await userEvent.type(
      await screen.findByLabelText("Title"),
      "Guide",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create page" }));

    // Naviga alla pagina creata (render markdown del body).
    expect(await screen.findByRole("article")).toBeInTheDocument();
    expect(posted).toMatchObject({ title: "Guide" });
  });

  it("modifica una pagina manuale via PATCH e mostra il body aggiornato", async () => {
    const updated = makePage({
      id: MANUAL_ID,
      slug: "guide",
      title: "Guide",
      kind: "manual",
      body: "# Guide\n\nUpdated content here.",
    });
    let patched: unknown = null;
    mockApi({
      ...baseHandlers(),
      // Dopo il PATCH la GET della pagina riflette il body aggiornato (la
      // mutation invalida la query → refetch).
      [`GET /api/repositories/${PROJECT_ID}/docs/pages/guide`]: () =>
        jsonResponse(200, patched ? updated : MANUAL_PAGE),
      [`PATCH /api/repositories/${PROJECT_ID}/docs/manual/${MANUAL_ID}`]: (_url, init) => {
        patched = JSON.parse(String(init?.body));
        return jsonResponse(200, updated);
      },
    });
    renderApp(`/docs/${PROJECT_ID}/guide`);

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    // Editor in modalità modifica.
    expect(await screen.findByText("Edit manual page")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patched).toMatchObject({ title: "Guide" }));
    expect(await screen.findByText("Updated content here.")).toBeInTheDocument();
  });

  it("elimina una pagina manuale e torna all'indice dello spazio", async () => {
    let deleted = false;
    mockApi({
      ...baseHandlers(),
      [`DELETE /api/repositories/${PROJECT_ID}/docs/manual/${MANUAL_ID}`]: () => {
        deleted = true;
        return jsonResponse(204, null);
      },
    });
    renderApp(`/docs/${PROJECT_ID}/guide`);

    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    // Conferma a due tempi.
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleted).toBe(true));
    // Indice dello spazio: placeholder "seleziona una pagina".
    expect(await screen.findByText("Select a page")).toBeInTheDocument();
  });

  it("conflitto di slug (409): mostra l'errore dedicato", async () => {
    mockApi({
      ...baseHandlers(),
      [`POST /api/repositories/${PROJECT_ID}/docs/manual`]: () =>
        jsonResponse(409, { message: "conflict", code: "doc_page_slug_conflict" }),
    });
    renderApp(`/docs/${PROJECT_ID}/new`);

    await userEvent.type(await screen.findByLabelText("Title"), "Guide");
    await userEvent.click(screen.getByRole("button", { name: "Create page" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Slug already used in this project.");
  });

  it("una pagina generata NON mostra i controlli di edit/delete", async () => {
    mockApi(baseHandlers());
    renderApp(`/docs/${PROJECT_ID}/tech-overview`);

    const article = await screen.findByRole("article");
    expect(within(article).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(article).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});

describe("trigger generazione + stato (M7.4)", () => {
  it("admin vede il bottone Generate e cliccandolo riflette lo stato queued", async () => {
    let statusCalls = 0;
    mockApi({
      "GET /api/auth/me": meHandler("admin"),
      [`GET /api/repositories/${PROJECT_ID}/docs/tree`]: () => jsonResponse(200, TREE),
      [`GET /api/repositories/${PROJECT_ID}/docs/status`]: () => {
        statusCalls += 1;
        // Dopo il trigger lo stato riporta un job queued.
        const latestJob =
          statusCalls > 1
            ? {
                id: "job1",
                status: "queued",
                trigger: "manual",
                error: null,
                createdAt: "2026-06-22T10:00:00.000Z",
                startedAt: null,
                finishedAt: null,
              }
            : null;
        return jsonResponse(200, { generation: null, latestJob, pinnedProvider: null });
      },
      [`GET /api/ai-providers`]: () => jsonResponse(200, []),
      [`POST /api/repositories/${PROJECT_ID}/docs/generate`]: () =>
        jsonResponse(202, {
          id: "job1",
          status: "queued",
          trigger: "manual",
          error: null,
          createdAt: "2026-06-22T10:00:00.000Z",
          startedAt: null,
          finishedAt: null,
        }),
    });
    renderApp(`/docs/${PROJECT_ID}`);

    const generate = await screen.findByRole("button", { name: "Generate documentation" });
    await userEvent.click(generate);

    // Lo stato riflette il job in corso.
    expect(await screen.findByText("A generation is in progress…")).toBeInTheDocument();
  });

  it("member NON vede il bottone Generate", async () => {
    mockApi(baseHandlers("member"));
    renderApp(`/docs/${PROJECT_ID}`);

    // Aspetta che la sidebar sia montata.
    await screen.findByRole("button", { name: /Technical/ });
    expect(
      screen.queryByRole("button", { name: "Generate documentation" }),
    ).not.toBeInTheDocument();
  });

  it("il pannello mostra lo stato dell'ultima generazione", async () => {
    mockApi({
      ...baseHandlers("admin"),
      [`GET /api/repositories/${PROJECT_ID}/docs/status`]: () =>
        jsonResponse(200, {
          generation: {
            id: "g1",
            status: "succeeded",
            commitSha: "deadbeef1234",
            model: "opus",
            cost: "1.230000",
            stats: null,
            startedAt: "2026-06-20T09:00:00.000Z",
            finishedAt: "2026-06-20T10:00:00.000Z",
            createdAt: "2026-06-20T09:00:00.000Z",
          },
          latestJob: {
            id: "j1",
            status: "succeeded",
            trigger: "manual",
            error: null,
            createdAt: "2026-06-20T09:00:00.000Z",
            startedAt: "2026-06-20T09:00:00.000Z",
            finishedAt: "2026-06-20T10:00:00.000Z",
          },
          pinnedProvider: null,
        }),
    });
    renderApp(`/docs/${PROJECT_ID}`);

    expect(await screen.findByText("succeeded")).toBeInTheDocument();
    expect(screen.getByText(/commit deadbee/)).toBeInTheDocument();
  });

  it("un job held mostra il motivo (job.error) oltre allo stato", async () => {
    mockApi({
      ...baseHandlers("admin"),
      [`GET /api/repositories/${PROJECT_ID}/docs/status`]: () =>
        jsonResponse(200, {
          generation: null,
          latestJob: {
            id: "j-held",
            status: "held",
            trigger: "manual",
            // Motivo del blocco (es. tetto di costo): deve comparire in chiaro.
            error: "Cost cap exceeded: estimated $12.00 over the $5.00 limit",
            createdAt: "2026-06-22T10:00:00.000Z",
            startedAt: "2026-06-22T10:00:00.000Z",
            finishedAt: null,
          },
          pinnedProvider: null,
        }),
    });
    renderApp(`/docs/${PROJECT_ID}`);

    expect(await screen.findByText("held")).toBeInTheDocument();
    // Il motivo è renderizzato (così l'utente capisce il PERCHÉ del blocco).
    expect(screen.getByText(/Cost cap exceeded/)).toBeInTheDocument();
  });

  // --- Provider bloccato (M7.4 — pinned provider) ---
  //
  // Il selettore di provider per-generazione è stato rimosso dal pannello: il
  // provider AI è ora una impostazione di progetto (vedi ProjectForm). La
  // generazione non manda più `providerId`; resta la sola riga di stato col
  // provider bloccato della generazione corrente.

  it("la POST generate non manda più il providerId", async () => {
    let posted: unknown = "no-body";
    let hadBody = true;
    mockApi({
      ...baseHandlers("admin"),
      [`POST /api/repositories/${PROJECT_ID}/docs/generate`]: (_url, init) => {
        hadBody = init?.body != null;
        posted = init?.body ? JSON.parse(String(init.body)) : null;
        return jsonResponse(202, {
          id: "job1",
          status: "queued",
          trigger: "manual",
          error: null,
          createdAt: "2026-06-22T10:00:00.000Z",
          startedAt: null,
          finishedAt: null,
        });
      },
    });
    renderApp(`/docs/${PROJECT_ID}`);

    // Nessun selettore di provider nel pannello.
    await screen.findByRole("button", { name: "Generate documentation" });
    expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Generate documentation" }));

    await waitFor(() => expect(hadBody).toBe(false));
    expect(posted).toBeNull();
  });

  // --- Pausa sul limite del provider (badge + "Riprendi ora") ---

  /** Stato con generazione in pausa per limite (job ancora "running"). */
  function pausedStatus() {
    return {
      generation: {
        id: "g-paused",
        status: "paused",
        commitSha: null,
        model: null,
        cost: null,
        stats: null,
        startedAt: "2026-07-02T10:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-07-02T10:00:00.000Z",
      },
      latestJob: {
        id: "j-run",
        status: "running",
        trigger: "manual",
        error: null,
        createdAt: "2026-07-02T10:00:00.000Z",
        startedAt: "2026-07-02T10:00:00.000Z",
        finishedAt: null,
      },
      pinnedProvider: null,
    };
  }

  it("generazione paused: avviso 'in pausa' e pulsante Riprendi ora per l'admin", async () => {
    mockApi({
      ...baseHandlers("admin"),
      [`GET /api/repositories/${PROJECT_ID}/docs/status`]: () => jsonResponse(200, pausedStatus()),
    });
    renderApp(`/docs/${PROJECT_ID}`);

    expect(
      await screen.findByText(/Generation paused: provider usage limit reached/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume now" })).toBeInTheDocument();
    // Il messaggio generico "in corso" non compare: la pausa lo sostituisce.
    expect(screen.queryByText("A generation is in progress…")).not.toBeInTheDocument();
  });

  it("click su Riprendi ora → POST /docs/resume e invalidazione dello status", async () => {
    let resumed = false;
    mockApi({
      ...baseHandlers("admin"),
      [`GET /api/repositories/${PROJECT_ID}/docs/status`]: () =>
        // Dopo il resume lo stato riflette la generazione tornata running.
        resumed
          ? jsonResponse(200, {
              ...pausedStatus(),
              generation: { ...pausedStatus().generation, status: "running" },
            })
          : jsonResponse(200, pausedStatus()),
      [`POST /api/repositories/${PROJECT_ID}/docs/resume`]: () => {
        resumed = true;
        return jsonResponse(200, { ...pausedStatus().generation, status: "running" });
      },
    });
    renderApp(`/docs/${PROJECT_ID}`);

    await userEvent.click(await screen.findByRole("button", { name: "Resume now" }));

    // La mutation invalida lo status: il refetch fa sparire l'avviso di pausa.
    await waitFor(() =>
      expect(
        screen.queryByText(/Generation paused: provider usage limit reached/),
      ).not.toBeInTheDocument(),
    );
    expect(resumed).toBe(true);
  });

  it("member: avviso di pausa visibile ma NIENTE pulsante Riprendi ora", async () => {
    mockApi({
      ...baseHandlers("member"),
      [`GET /api/repositories/${PROJECT_ID}/docs/status`]: () => jsonResponse(200, pausedStatus()),
    });
    renderApp(`/docs/${PROJECT_ID}`);

    expect(
      await screen.findByText(/Generation paused: provider usage limit reached/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume now" })).not.toBeInTheDocument();
  });

  it("mostra il provider bloccato della generazione corrente", async () => {
    mockApi({
      ...baseHandlers("admin"),
      [`GET /api/repositories/${PROJECT_ID}/docs/status`]: () =>
        jsonResponse(200, {
          generation: null,
          latestJob: null,
          pinnedProvider: { id: "p1", label: "Claude account", kind: "account" },
        }),
    });
    renderApp(`/docs/${PROJECT_ID}`);

    expect(await screen.findByText("Provider: Claude account")).toBeInTheDocument();
  });
});

/** Risposta vuota della corsia veloce `/api/search` (tutti i gruppi senza item). */
function emptySearchResults() {
  return {
    tickets: { items: [], hasMore: false },
    projects: { items: [], hasMore: false },
    repositories: { items: [], hasMore: false },
    docs: { items: [], hasMore: false },
  };
}

describe("ricerca via command palette (Cmd/K)", () => {
  it("il trigger nella sidebar apre la palette; digitando una query mostra i risultati", async () => {
    // La palette dei Docs è ora lo spotlight globale ancorato al repo: full-text
    // via `/api/search` (scope repo), semantica via `/api/search/docs-semantic`.
    mockApi({
      ...baseHandlers(),
      "GET /api/search/history": () => jsonResponse(200, []),
      "GET /api/search": () =>
        jsonResponse(200, {
          ...emptySearchResults(),
          docs: {
            items: [
              {
                slug: "guide",
                title: "Guide",
                kind: "manual",
                snippet: "A manual onboarding guide.",
                repositoryId: PROJECT_ID,
                repositorySlug: "repo",
                repositoryName: "Repo",
              },
            ],
            hasMore: false,
          },
        }),
      "GET /api/search/docs-semantic": () => jsonResponse(200, []),
    });
    renderApp(`/docs/${PROJECT_ID}`);

    // Il trigger (button con aria-label = label della palette) apre il dialog.
    const trigger = await screen.findByRole("button", { name: "Search documentation" });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");

    // Digito nella palette: lo snippet identifica univocamente il risultato.
    await userEvent.type(within(dialog).getByRole("textbox"), "guide");
    expect(await within(dialog).findByText("A manual onboarding guide.")).toBeInTheDocument();
  });

  it("la scorciatoia Cmd/K apre la palette", async () => {
    mockApi({
      ...baseHandlers(),
      "GET /api/search/history": () => jsonResponse(200, []),
    });
    renderApp(`/docs/${PROJECT_ID}`);

    // Finché non si preme Cmd/K la palette è chiusa.
    await screen.findByRole("button", { name: "Search documentation" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("nessun risultato: mostra lo stato vuoto nella palette", async () => {
    mockApi({
      ...baseHandlers(),
      "GET /api/search/history": () => jsonResponse(200, []),
      "GET /api/search": () => jsonResponse(200, emptySearchResults()),
      "GET /api/search/docs-semantic": () => jsonResponse(200, []),
    });
    renderApp(`/docs/${PROJECT_ID}`);

    await userEvent.click(await screen.findByRole("button", { name: "Search documentation" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox"), "zzzz");

    expect(await within(dialog).findByText("No results")).toBeInTheDocument();
  });
});
