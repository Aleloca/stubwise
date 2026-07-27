import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMatchMedia } from "../test/setup";
import { createAppRouter } from "../router";

/**
 * Landing della documentazione di progetto (`/docs/project/$projectId`) col
 * router vero (memory history) e fetch mockata a livello di rete: l'intestazione
 * col nome progetto, gli spazi-repo del progetto (link alle viste per-repo), e
 * la chat cross-repo le cui citazioni mostrano il repository e linkano alla
 * route per-repo corretta.
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REPO_API = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO_WEB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Costruisce una Response streaming da frame SSE già formattati. */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // Desktop: la chat è una colonna affiancata, sempre montata (open di default).
  setMatchMedia("(min-width: 1024px)", true);
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

/** Highlights di progetto: changelog cross-repo + pagine più lette. */
function highlightsHandler(releases: unknown[] = []): Handler {
  return () =>
    jsonResponse(200, {
      countsByKind: { technical: 0, functional: 0, product: 0, manual: 0, releases: releases.length },
      topViewed: [],
      latestReleases: releases,
    });
}

/** Brief del repo principale (identity = sintesi mostrata nell'hero). */
function briefHandler(identity: string): Handler {
  return () =>
    jsonResponse(200, {
      brief: {
        identity,
        actors: [],
        surfaces: [],
        glossary: [],
        invariants: [],
        confidentialFacts: [],
        journeys: [],
        existingSources: [],
      },
      generation: { createdAt: "2026-06-20T10:00:00.000Z", commitSha: "abc1234" },
      productExclusions: [],
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

describe("landing documentazione di progetto", () => {
  it("mostra il nome progetto e i suoi repo-spazi (link alle viste per-repo)", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/projects/11111111-1111-4111-8111-111111111111": () =>
        jsonResponse(200, {
          id: PROJECT_ID,
          name: "Acme",
          slug: "acme",
          description: null,
          aiProviderId: null,
          docAutoUpdate: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          repositories: [],
        }),
      "GET /api/projects/11111111-1111-4111-8111-111111111111/docs/spaces": () =>
        jsonResponse(200, [
          {
            repositoryId: REPO_API,
            slug: "api",
            name: "API",
            pageCount: 8,
            lastGenerationAt: "2026-06-20T10:00:00.000Z",
            lastCommitSha: "abc1234",
          },
          {
            repositoryId: REPO_WEB,
            slug: "web",
            name: "Web",
            pageCount: 3,
            lastGenerationAt: null,
            lastCommitSha: null,
          },
        ]),
      "GET /api/projects/11111111-1111-4111-8111-111111111111/docs/highlights":
        highlightsHandler([
          {
            slug: "release-20260724-1000-abc1234",
            title: "Nuova ricerca cross-repo",
            createdAt: "2026-07-24T10:00:00.000Z",
            significant: true,
            commitSha: null,
            repositoryId: REPO_WEB,
            repositorySlug: "web",
            repositoryName: "Web",
          },
        ]),
      // Il brief del repo principale (API, più pagine) alimenta l'hero.
      "GET /api/repositories/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/docs/brief": briefHandler(
        "Acme è la piattaforma di fatturazione interna.",
      ),
    });

    renderApp(`/docs/project/${PROJECT_ID}`);

    expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByText("All the project's repositories")).toBeInTheDocument();

    // Card repo: dentro la sezione dei repository del progetto.
    const repos = screen.getByRole("region", { name: /all the project's repositories/i });
    expect(within(repos).getByRole("link", { name: /API/ })).toHaveAttribute(
      "href",
      `/docs/${REPO_API}`,
    );
    expect(within(repos).getByRole("link", { name: /Web/ })).toHaveAttribute(
      "href",
      `/docs/${REPO_WEB}`,
    );
  });

  it("l'hero mostra la sintesi dal brief e i punti d'ingresso, non la frase generica", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/projects/11111111-1111-4111-8111-111111111111": () =>
        jsonResponse(200, {
          id: PROJECT_ID,
          name: "Acme",
          slug: "acme",
          description: null,
          aiProviderId: null,
          docAutoUpdate: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          repositories: [],
        }),
      "GET /api/projects/11111111-1111-4111-8111-111111111111/docs/spaces": () =>
        jsonResponse(200, [
          {
            repositoryId: REPO_API,
            slug: "api",
            name: "API",
            pageCount: 8,
            lastGenerationAt: "2026-06-20T10:00:00.000Z",
            lastCommitSha: "abc1234",
          },
        ]),
      "GET /api/projects/11111111-1111-4111-8111-111111111111/docs/highlights":
        highlightsHandler([
          {
            slug: "release-20260724-1000-abc1234",
            title: "Nuova ricerca cross-repo",
            createdAt: "2026-07-24T10:00:00.000Z",
            significant: true,
            commitSha: null,
            repositoryId: REPO_API,
            repositorySlug: "api",
            repositoryName: "API",
          },
        ]),
      "GET /api/repositories/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/docs/brief": briefHandler(
        "Acme è la piattaforma di fatturazione interna.",
      ),
    });

    renderApp(`/docs/project/${PROJECT_ID}`);

    // Sintesi dal brief al posto del sottotitolo boilerplate.
    expect(
      await screen.findByText("Acme è la piattaforma di fatturazione interna."),
    ).toBeInTheDocument();

    // "Inizia da qui": brief del repo principale + overview del repo.
    const start = await screen.findByRole("region", { name: /start here/i });
    expect(within(start).getByRole("link", { name: /brief/i })).toHaveAttribute(
      "href",
      `/docs/${REPO_API}/brief`,
    );

    // Novità: changelog cross-repo con data e link alla vista release del repo.
    const news = screen.getByRole("region", { name: /what.s new/i });
    expect(within(news).getByText("Nuova ricerca cross-repo")).toBeInTheDocument();
    expect(within(news).getByText("24/07/2026")).toBeInTheDocument();
    expect(within(news).getByRole("link", { name: "API" })).toHaveAttribute(
      "href",
      `/docs/${REPO_API}/releases`,
    );
  });

  it("su desktop la chat è già aperta e mostra le domande suggerite", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/projects/11111111-1111-4111-8111-111111111111": () =>
        jsonResponse(200, {
          id: PROJECT_ID,
          name: "Acme",
          slug: "acme",
          description: null,
          aiProviderId: null,
          docAutoUpdate: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          repositories: [],
        }),
      "GET /api/projects/11111111-1111-4111-8111-111111111111/docs/spaces": () =>
        jsonResponse(200, []),
      "GET /api/projects/11111111-1111-4111-8111-111111111111/docs/highlights":
        highlightsHandler(),
    });

    renderApp(`/docs/project/${PROJECT_ID}`);

    await screen.findByRole("heading", { name: "Acme" });
    // Colonna chat montata subito (desktop), senza pulsante di apertura.
    expect(await screen.findByLabelText(/ask about this project/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ask the docs/i })).not.toBeInTheDocument();
    // Domande suggerite come chip cliccabili nell'empty state.
    expect(
      screen.getByRole("button", { name: "What does this project do?" }),
    ).toBeInTheDocument();
  });

  it("la chat cross-repo cita il repository e linka alla pagina nel repo giusto", async () => {
    mockApi({
      "GET /api/auth/me": meHandler(),
      "GET /api/projects/11111111-1111-4111-8111-111111111111": () =>
        jsonResponse(200, {
          id: PROJECT_ID,
          name: "Acme",
          slug: "acme",
          description: null,
          aiProviderId: null,
          docAutoUpdate: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          repositories: [],
        }),
      "GET /api/projects/11111111-1111-4111-8111-111111111111/docs/spaces": () =>
        jsonResponse(200, [
          {
            repositoryId: REPO_API,
            slug: "api",
            name: "API",
            pageCount: 8,
            lastGenerationAt: null,
            lastCommitSha: null,
          },
        ]),
      "GET /api/projects/11111111-1111-4111-8111-111111111111/docs/highlights":
        highlightsHandler(),
      "GET /api/repositories/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/docs/brief": () =>
        jsonResponse(404, { code: "doc_brief_not_found", message: "No brief" }),
      "POST /api/projects/11111111-1111-4111-8111-111111111111/docs/chat": () =>
        sseResponse([
          sse({ type: "delta", text: "Billing lives in the web repo." }),
          sse({
            type: "done",
            sessionId: "p1",
            citations: [
              {
                slug: "billing",
                title: "Billing",
                kind: "functional",
                repositoryId: REPO_WEB,
                repositorySlug: "web",
                repositoryName: "Web",
              },
            ],
          }),
        ]),
    });

    const user = userEvent.setup();
    renderApp(`/docs/project/${PROJECT_ID}`);

    // Su desktop la chat è già montata: si scrive direttamente.
    const input = await screen.findByLabelText(/ask about this project/i);
    await user.type(input, "where is billing?");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() =>
      expect(screen.getByText("Billing lives in the web repo.")).toBeInTheDocument(),
    );

    // La citazione mostra il repository d'origine e linka alla route per-repo
    // del repo giusto (REPO_WEB), non del progetto.
    expect(screen.getByText(/Web ›/)).toBeInTheDocument();
    const billingLink = await screen.findByRole("link", { name: /Billing/ });
    expect(billingLink).toHaveAttribute("href", `/docs/${REPO_WEB}/billing`);
  });
});
