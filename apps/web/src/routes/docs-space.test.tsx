import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocPage, DocTreeNode } from "../lib/docs-api";
import { createAppRouter } from "../router";
import { setMatchMedia } from "../test/setup";

/** Breakpoint `lg`: sopra → sidebar/chat come colonne; sotto → drawer. */
const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * Spazio Docs con il router vero (memory history) e fetch mockata a livello di
 * rete: i tre gruppi dell'albero (Tecnico/Funzionale/Manuale) con annidamento,
 * la navigazione a una pagina (render markdown + badge sorgente/commit), la
 * pagina manuale senza badge generazione, e l'evidenziazione della pagina
 * attiva.
 */

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
  return () => jsonResponse(200, { user: { id: "u1", email: "ada@example.com", role: "member" } });
}

function node(overrides: Partial<DocTreeNode> & Pick<DocTreeNode, "id" | "slug" | "title" | "kind">): DocTreeNode {
  return {
    parentId: null,
    position: 0,
    sourcePath: null,
    isManual: overrides.kind === "manual",
    createdAt: "2026-06-20T10:00:00.000Z",
    viewCount: 0,
    significant: null,
    ...overrides,
  };
}

// Albero: overview tecnica con un modulo annidato, una pagina funzionale, una
// manuale.
const TREE: DocTreeNode[] = [
  node({ id: "t1", slug: "tech-overview", title: "Technical overview", kind: "technical" }),
  node({
    id: "t2",
    slug: "module-auth",
    title: "Auth module",
    kind: "technical",
    parentId: "t1",
    position: 0,
    sourcePath: "src/auth",
  }),
  node({ id: "f1", slug: "func-overview", title: "Functional overview", kind: "functional" }),
  node({ id: "m1", slug: "getting-started", title: "Getting started", kind: "manual" }),
];

function makePage(overrides: Partial<DocPage> & Pick<DocPage, "slug" | "title" | "kind">): DocPage {
  return {
    id: overrides.slug,
    parentId: null,
    position: 0,
    sourcePath: null,
    body: `# ${overrides.title}\n\nBody for ${overrides.slug}.`,
    isManual: overrides.kind === "manual",
    commitSha: null,
    updatedAt: "2026-06-20T10:00:00.000Z",
    createdAt: "2026-06-20T10:00:00.000Z",
    viewCount: 0,
    significant: null,
    ...overrides,
  };
}

const PAGES: Record<string, DocPage> = {
  "module-auth": makePage({
    slug: "module-auth",
    title: "Auth module",
    kind: "technical",
    sourcePath: "src/auth",
    commitSha: "abc1234def5678",
    body: "# Auth module\n\nThis documents **authentication**.",
  }),
  "getting-started": makePage({
    slug: "getting-started",
    title: "Getting started",
    kind: "manual",
    body: "# Getting started\n\nManual onboarding.",
  }),
  // Pagina funzionale con cross-link di tutti e tre i type.
  "func-overview": makePage({
    slug: "func-overview",
    title: "Functional overview",
    kind: "functional",
    body: "# Functional overview\n\nFunctional body.",
    links: [
      { type: "implements", slug: "module-auth", title: "Auth module" },
      { type: "implemented_by", slug: "tech-overview", title: "Technical overview" },
      { type: "related", slug: "getting-started", title: "Getting started" },
    ],
  }),
};

function treeHandlers(): Record<string, Handler> {
  return {
    "GET /api/auth/me": meHandler(),
    [`GET /api/repositories/${PROJECT_ID}/docs/tree`]: () => jsonResponse(200, TREE),
    [`GET /api/repositories/${PROJECT_ID}/docs/pages/module-auth`]: () =>
      jsonResponse(200, PAGES["module-auth"]),
    [`GET /api/repositories/${PROJECT_ID}/docs/pages/getting-started`]: () =>
      jsonResponse(200, PAGES["getting-started"]),
    [`GET /api/repositories/${PROJECT_ID}/docs/pages/func-overview`]: () =>
      jsonResponse(200, PAGES["func-overview"]),
  };
}

function renderApp(initialPath: string, { desktop = true }: { desktop?: boolean } = {}) {
  // Default desktop: la sidebar è un aside fisso (albero/ricerca sempre montati).
  // I test mobile passano `desktop: false` per esercitare i drawer.
  setMatchMedia(DESKTOP_QUERY, desktop);
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

describe("spazio documentazione", () => {
  it("mostra i tre gruppi con le pagine annidate e il placeholder sull'indice", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}`);

    // I tre gruppi (header con conteggio: il regex col numero esclude i chevron
    // dei nodi, le cui aria-label contengono il titolo es. "Technical overview").
    expect(await screen.findByRole("button", { name: /Technical \d/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Functional \d/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Manual \d/ })).toBeInTheDocument();

    // La categoria attiva (technical) mostra le sue pagine, incluso l'annidamento.
    const overview = screen.getByRole("link", { name: "Technical overview" });
    const authModule = screen.getByRole("link", { name: "Auth module" });
    expect(overview).toBeInTheDocument();
    expect(authModule).toBeInTheDocument();
    // Le altre categorie sono dietro la loro tab: una sola per volta.
    expect(screen.queryByRole("link", { name: "Functional overview" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Functional \d/ }));
    expect(screen.getByRole("link", { name: "Functional overview" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Manual \d/ }));
    expect(screen.getByRole("link", { name: "Getting started" })).toBeInTheDocument();

    // I link puntano allo slug.
    await userEvent.click(screen.getByRole("button", { name: /Technical \d/ }));
    expect(screen.getByRole("link", { name: "Auth module" })).toHaveAttribute(
      "href",
      `/docs/${PROJECT_ID}/module-auth`,
    );
  });

  it("naviga a una pagina: render markdown + badge sorgente/commit", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}`);

    const authModule = await screen.findByRole("link", { name: "Auth module" });
    await userEvent.click(authModule);

    // Corpo markdown renderizzato (riuso del componente Markdown).
    expect(await screen.findByText("authentication")).toHaveProperty("tagName", "STRONG");
    // Titolo nell'header dell'articolo (l'header del body markdown è separato).
    const article = screen.getByRole("article");
    expect(within(article.querySelector("header")!).getByText("Auth module")).toBeInTheDocument();

    // Badge: documenta source_path + commit (sha breve).
    expect(screen.getByText("documents src/auth")).toBeInTheDocument();
    expect(screen.getByText("generated at commit abc1234")).toBeInTheDocument();
  });

  it("la pagina attiva è evidenziata", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}/module-auth`);

    const authModule = await screen.findByRole("link", { name: "Auth module" });
    await waitFor(() => expect(authModule).toHaveAttribute("data-status", "active"));

    // Un'altra pagina della stessa categoria non è attiva.
    expect(screen.getByRole("link", { name: "Technical overview" })).not.toHaveAttribute(
      "data-status",
      "active",
    );
  });

  it("pagina manuale: nessun badge sorgente/commit di generazione", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}/getting-started`);

    const article = await screen.findByRole("article");
    // Titolo nell'header dell'articolo.
    expect(within(article.querySelector("header")!).getByText("Getting started")).toBeInTheDocument();
    // Nessun badge di generazione.
    expect(screen.queryByText(/^documents /)).not.toBeInTheDocument();
    expect(screen.queryByText(/^generated at commit /)).not.toBeInTheDocument();
    // Ma il badge "manual page" è presente.
    expect(within(article).getByText("manual page")).toBeInTheDocument();
  });

  it("pagina con cross-link: sezione Related raggruppata con gli href corretti", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}/func-overview`);

    const article = await screen.findByRole("article");
    // La sezione cross-link (aria-label = heading) raggruppa i tre type.
    const section = within(article).getByRole("region", { name: "Related" });
    expect(within(section).getByText("Implemented by")).toBeInTheDocument();
    expect(within(section).getByText("Implements")).toBeInTheDocument();
    // "Related" compare sia come heading sia come label di gruppo.
    expect(within(section).getAllByText("Related").length).toBeGreaterThanOrEqual(2);

    // Ogni link punta allo slug del target.
    const implementsLink = within(section).getByRole("link", { name: "Auth module" });
    expect(implementsLink).toHaveAttribute("href", `/docs/${PROJECT_ID}/module-auth`);
    const implementedByLink = within(section).getByRole("link", { name: "Technical overview" });
    expect(implementedByLink).toHaveAttribute("href", `/docs/${PROJECT_ID}/tech-overview`);
    const relatedLink = within(section).getByRole("link", { name: "Getting started" });
    expect(relatedLink).toHaveAttribute("href", `/docs/${PROJECT_ID}/getting-started`);
  });

  it("pagina senza cross-link: nessuna sezione Related", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}/getting-started`);

    const article = await screen.findByRole("article");
    // La pagina manuale non ha links (null) → niente sezione.
    expect(within(article).queryByRole("region", { name: "Related" })).not.toBeInTheDocument();
  });

  it("404: messaggio amichevole di pagina non trovata", async () => {
    mockApi({
      ...treeHandlers(),
      [`GET /api/repositories/${PROJECT_ID}/docs/pages/ghost`]: () =>
        jsonResponse(404, { message: "not found", code: "doc_page_not_found" }),
    });
    renderApp(`/docs/${PROJECT_ID}/ghost`);

    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });
});

describe("spazio documentazione — mobile (drawer)", () => {
  it("la sotto-barra Docs (lg:hidden) ha i bottoni Indice e Chat; su desktop la sidebar è un aside, non un drawer", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}`, { desktop: true });

    // Sotto-barra sempre nel DOM (nascosta via CSS su desktop): Indice + Chat.
    const indexBtn = await screen.findByRole("button", { name: "Index" });
    const chatBtn = screen.getByRole("button", { name: "Chat" });
    expect(indexBtn).toBeInTheDocument();
    expect(chatBtn).toBeInTheDocument();

    // A11y: i bottoni della sotto-barra puntano al pannello che controllano
    // (parità Index/Chat), target degli `id` sui rispettivi drawer.
    expect(indexBtn).toHaveAttribute("aria-controls", "docs-tree-drawer");
    expect(chatBtn).toHaveAttribute("aria-controls", "docs-chat-drawer");

    // La sotto-barra è `lg:hidden` (sparisce su desktop).
    const subbar = screen.getByLabelText("Documentation toolbar");
    expect(subbar.className).toContain("lg:hidden");

    // Su desktop la sidebar è un aside fisso (l'albero NON è dentro un drawer):
    // l'albero è montato e non esiste alcun dialog (drawer) nel DOM.
    expect(screen.getByRole("link", { name: "Auth module" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cliccare 'Index' apre il drawer albero; selezionare una pagina lo chiude", async () => {
    mockApi(treeHandlers());
    const router = renderApp(`/docs/${PROJECT_ID}`, { desktop: false });
    const user = userEvent.setup();

    // Il bottone 'Index' apre il drawer (role=dialog) con l'albero.
    await user.click(await screen.findByRole("button", { name: "Index" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-label", "Documentation index");

    // L'albero vive dentro il drawer.
    const authModule = within(dialog).getByRole("link", { name: "Auth module" });
    await user.click(authModule);

    // Selezione → naviga alla pagina e il drawer si chiude (route change + onNavigate).
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/docs/${PROJECT_ID}/module-auth`),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Escape chiude il drawer albero", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}`, { desktop: false });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Index" }));
    expect(
      await screen.findByRole("dialog", { name: "Documentation index" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("cliccare 'Chat' nella sotto-barra apre la chat in un drawer da destra", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}`, { desktop: false });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Chat" }));

    // La chat è in un drawer (aria-label = titolo chat) ed è interattiva.
    const dialog = await screen.findByRole("dialog", { name: "Ask the docs" });
    expect(dialog).not.toHaveAttribute("aria-hidden", "true");
    // Il pannello porta l'id target dell'aria-controls del bottone "Chat".
    expect(dialog).toHaveAttribute("id", "docs-chat-drawer");
    expect(within(dialog).getByLabelText(/ask about this project/i)).toBeInTheDocument();
  });

  it("il FAB apre la stessa chat-drawer (stato unico)", async () => {
    mockApi(treeHandlers());
    renderApp(`/docs/${PROJECT_ID}`, { desktop: false });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /open chat/i }));
    const dialog = await screen.findByRole("dialog", { name: "Ask the docs" });
    expect(within(dialog).getByLabelText(/ask about this project/i)).toBeInTheDocument();
  });
});

describe("spazio documentazione — command palette (Cmd/K)", () => {
  it("il trigger nella sidebar apre la palette", async () => {
    mockApi({
      ...treeHandlers(),
      "GET /api/search/history": () => jsonResponse(200, []),
    });
    renderApp(`/docs/${PROJECT_ID}`);
    const user = userEvent.setup();

    // Prima del click la palette è chiusa; il trigger (button con aria-label) la apre.
    const trigger = await screen.findByRole("button", { name: "Search documentation" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(trigger);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("la scorciatoia Cmd/K apre la palette", async () => {
    mockApi({
      ...treeHandlers(),
      "GET /api/search/history": () => jsonResponse(200, []),
    });
    renderApp(`/docs/${PROJECT_ID}`);
    const user = userEvent.setup();

    await screen.findByRole("button", { name: "Search documentation" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
