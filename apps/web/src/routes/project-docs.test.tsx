import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
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
    });

    renderApp(`/docs/project/${PROJECT_ID}`);

    expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByText("All the project's repositories")).toBeInTheDocument();

    const apiLink = screen.getByRole("link", { name: /API/ });
    const webLink = screen.getByRole("link", { name: /Web/ });
    expect(apiLink).toHaveAttribute("href", `/docs/${REPO_API}`);
    expect(webLink).toHaveAttribute("href", `/docs/${REPO_WEB}`);
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

    // La chat di progetto è montata (titolo/placeholder dedicati).
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
