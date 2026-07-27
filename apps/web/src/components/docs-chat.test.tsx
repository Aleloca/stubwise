import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { setMatchMedia } from "../test/setup";
import { DocsChat } from "./docs-chat";

/** Breakpoint `lg`: sopra → colonna affiancata; sotto → drawer da destra. */
const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * Test del widget chat (M7.5). Mocka `postDocChat` per restituire una `Response`
 * il cui body stremma eventi SSE canned (delta×N poi `done` con citazioni).
 * Verifica: render incrementale del messaggio assistant; citazioni come link
 * verso `/docs/$projectId/$slug`; evento `error` → stato d'errore; secondo
 * messaggio riusa il sessionId echeggiato dal `done` (multi-turn).
 */

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Mock del modulo API: solo i POST chat (per-repo e di progetto), le altre
// export restano reali.
const postDocChat = vi.fn();
const postProjectDocChat = vi.fn();
vi.mock("../lib/docs-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/docs-api")>();
  return {
    ...actual,
    postDocChat: (...args: unknown[]) => postDocChat(...args),
    postProjectDocChat: (...args: unknown[]) => postProjectDocChat(...args),
  };
});

/**
 * Costruisce una `Response` streaming da una lista di stringhe-evento SSE già
 * formattate (`data: {json}\n\n`). Le emette in chunk distinti così il widget
 * deve davvero accumularle attraverso più read() (render incrementale reale).
 */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Helper: formatta un evento come frame SSE. */
function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function renderChat() {
  const rootRoute = createRootRoute({ component: () => <DocsChat projectId={PROJECT_ID} /> });
  // La rotta target dei Link citazione deve esistere nel router minimale.
  const spaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs/$projectId" });
  const pageRoute = createRoute({ getParentRoute: () => spaceRoute, path: "/$slug" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([spaceRoute.addChildren([pageRoute])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

/**
 * Variante di progetto (`scope="project"`): `projectId` è un vero projectId, ma
 * le citazioni linkano alla route per-repo `/docs/<repositoryId>/<slug>`.
 */
const PROJECT_SCOPE_ID = "99999999-9999-4999-8999-999999999999";

function renderProjectChat() {
  const rootRoute = createRootRoute({
    component: () => <DocsChat projectId={PROJECT_SCOPE_ID} scope="project" />,
  });
  const spaceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs/$projectId" });
  const pageRoute = createRoute({ getParentRoute: () => spaceRoute, path: "/$slug" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([spaceRoute.addChildren([pageRoute])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

/**
 * Apre il drawer (è chiuso di default) e restituisce la textarea. La copy del
 * pulsante è scope-aware: "Open chat" per-repo, "Ask the docs" di progetto.
 */
async function openChat(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /open chat|ask the docs/i }));
  return screen.findByLabelText(/ask about this project/i);
}

afterEach(() => {
  postDocChat.mockReset();
  postProjectDocChat.mockReset();
});

describe("DocsChat", () => {
  it("stremma i delta e renderizza incrementalmente fino al testo completo + citazioni cliccabili", async () => {
    postDocChat.mockResolvedValueOnce(
      sseResponse([
        sse({ type: "delta", text: "Hello " }),
        sse({ type: "delta", text: "from " }),
        sse({ type: "delta", text: "the docs." }),
        sse({
          type: "done",
          sessionId: "session-1",
          citations: [{ slug: "auth", title: "Authentication", kind: "technical" }],
        }),
      ]),
    );

    const user = userEvent.setup();
    renderChat();
    const input = await openChat(user);

    await user.type(input, "How does auth work?");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    // La domanda dell'utente compare.
    expect(await screen.findByText("How does auth work?")).toBeInTheDocument();
    // Il testo assistant si compone fino al completo.
    await waitFor(() => expect(screen.getByText("Hello from the docs.")).toBeInTheDocument());

    // Citazione come link verso /docs/$projectId/$slug.
    const link = await screen.findByRole("link", { name: /Authentication/ });
    expect(link).toHaveAttribute("href", `/docs/${PROJECT_ID}/auth`);
  });

  it("evento `error`: mostra lo stato d'errore", async () => {
    postDocChat.mockResolvedValueOnce(
      sseResponse([
        sse({ type: "delta", text: "partial" }),
        sse({ type: "error", message: "boom" }),
      ]),
    );

    const user = userEvent.setup();
    renderChat();
    const input = await openChat(user);

    await user.type(input, "trigger error");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/went wrong/i);
  });

  it("chat non servibile (503 chat_unavailable): mostra il messaggio dedicato, non il generico", async () => {
    // Il pre-flight del server risponde 503 → postDocChat lancia un ApiError col
    // codice `chat_unavailable`. La UI deve mostrare il messaggio attuabile
    // (configura un provider API key), distinto dal generico errore di stream.
    postDocChat.mockRejectedValueOnce(
      new ApiError(503, "Docs chat requires an API-key AI provider", "chat_unavailable"),
    );

    const user = userEvent.setup();
    renderChat();
    const input = await openChat(user);

    await user.type(input, "any question");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/api-key ai provider/i);
    // NON è il messaggio generico d'errore di generazione.
    expect(alert).not.toHaveTextContent(/went wrong/i);
  });

  it("citazioni malformate: scartate senza rompere il render", async () => {
    postDocChat.mockResolvedValueOnce(
      sseResponse([
        sse({ type: "delta", text: "answer" }),
        sse({
          type: "done",
          sessionId: "session-x",
          citations: [
            { slug: "ok", title: "Good page", kind: "functional" },
            { title: "missing slug" },
            null,
            "not-an-object",
            { slug: 42, title: "bad slug type" },
          ],
        }),
      ]),
    );

    const user = userEvent.setup();
    renderChat();
    const input = await openChat(user);

    await user.type(input, "give me sources");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    // Solo la citazione valida è renderizzata; le malformate sono scartate.
    expect(await screen.findByRole("link", { name: /Good page/ })).toBeInTheDocument();
    expect(screen.queryByText("missing slug")).not.toBeInTheDocument();
    expect(screen.queryByText("bad slug type")).not.toBeInTheDocument();
  });

  it("multi-turn: il secondo messaggio riusa il sessionId echeggiato dal primo `done`", async () => {
    postDocChat
      .mockResolvedValueOnce(
        sseResponse([
          sse({ type: "delta", text: "first answer" }),
          sse({ type: "done", sessionId: "sess-42", citations: [] }),
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          sse({ type: "delta", text: "second answer" }),
          sse({ type: "done", sessionId: "sess-42", citations: [] }),
        ]),
      );

    const user = userEvent.setup();
    renderChat();
    const input = await openChat(user);

    await user.type(input, "first question");
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(screen.getByText("first answer")).toBeInTheDocument());

    // Primo turno: nessun sessionId (nuova sessione).
    expect(postDocChat).toHaveBeenNthCalledWith(1, PROJECT_ID, {
      sessionId: undefined,
      message: "first question",
    });

    await user.type(input, "second question");
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(screen.getByText("second answer")).toBeInTheDocument());

    // Secondo turno: riusa il sessionId dal primo `done`.
    expect(postDocChat).toHaveBeenNthCalledWith(2, PROJECT_ID, {
      sessionId: "sess-42",
      message: "second question",
    });
  });

  it("stato vuoto: niente messaggi finché non si invia", async () => {
    const user = userEvent.setup();
    renderChat();
    await openChat(user);
    expect(screen.getByText(/ask anything about the docs/i)).toBeInTheDocument();
  });

  it("mobile (< lg): la chat aperta è un drawer da destra, chiuso da backdrop ed Escape", async () => {
    // Default matchMedia = mobile (tutte le query false): la chat vive nel drawer.
    const user = userEvent.setup();
    renderChat();

    await user.click(await screen.findByRole("button", { name: /open chat/i }));

    // Pannello = dialog (role del Drawer), interattivo, con la textarea.
    const dialog = await screen.findByRole("dialog", { name: /ask the docs/i });
    expect(within(dialog).getByLabelText(/ask about this project/i)).toBeInTheDocument();
    // Il wrapper del Drawer NON è aria-hidden mentre è aperto.
    expect(dialog.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "false");

    // Escape chiude: il dialog non è più nell'albero accessibile (wrapper aria-hidden).
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Riapri e chiudi cliccando il backdrop.
    await user.click(screen.getByRole("button", { name: /open chat/i }));
    await screen.findByRole("dialog", { name: /ask the docs/i });
    const backdrop = document.querySelector("[data-drawer-backdrop]") as HTMLElement;
    await user.click(backdrop);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("desktop (lg+): la chat è una colonna sempre presente, senza drawer né chiusura", async () => {
    setMatchMedia(DESKTOP_QUERY, true);
    renderChat();

    // Montata subito, senza bisogno di aprirla: è parte del layout.
    expect(await screen.findByLabelText(/ask about this project/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Niente FAB di apertura né pulsante di chiusura: si ridimensiona, non si chiude.
    expect(screen.queryByRole("button", { name: /open chat|ask the docs/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close chat/i })).not.toBeInTheDocument();
    // L'handle di resize è al suo posto.
    expect(screen.getByRole("separator", { name: /resize chat/i })).toBeInTheDocument();
  });

  it("più citazioni: tutte renderizzate come link distinti", async () => {
    postDocChat.mockResolvedValueOnce(
      sseResponse([
        sse({ type: "delta", text: "multi" }),
        sse({
          type: "done",
          sessionId: "s",
          citations: [
            { slug: "a", title: "Page A", kind: "technical" },
            { slug: "b", title: "Page B", kind: "manual" },
          ],
        }),
      ]),
    );

    const user = userEvent.setup();
    renderChat();
    const input = await openChat(user);
    await user.type(input, "q");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    const a = await screen.findByRole("link", { name: /Page A/ });
    const b = await screen.findByRole("link", { name: /Page B/ });
    expect(a).toHaveAttribute("href", `/docs/${PROJECT_ID}/a`);
    expect(b).toHaveAttribute("href", `/docs/${PROJECT_ID}/b`);
    // Sanity: vivono entrambi sotto la sezione "Sources".
    expect(within(a.closest("ul")!).getAllByRole("link")).toHaveLength(2);
  });
});

describe("DocsChat (scope=project)", () => {
  const REPO_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const REPO_Y = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("usa l'endpoint di progetto e le citazioni mostrano il repo + linkano alla route per-repo", async () => {
    postProjectDocChat.mockResolvedValueOnce(
      sseResponse([
        sse({ type: "delta", text: "cross-repo answer" }),
        sse({
          type: "done",
          sessionId: "p-sess-1",
          citations: [
            {
              slug: "auth",
              title: "Authentication",
              kind: "technical",
              repositoryId: REPO_X,
              repositorySlug: "api",
              repositoryName: "API",
            },
            {
              slug: "billing",
              title: "Billing",
              kind: "functional",
              repositoryId: REPO_Y,
              repositorySlug: "web",
              repositoryName: "Web",
            },
          ],
        }),
      ]),
    );

    const user = userEvent.setup();
    renderProjectChat();
    const input = await openChat(user);

    await user.type(input, "how does billing relate to auth?");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(screen.getByText("cross-repo answer")).toBeInTheDocument());

    // Il POST è andato all'endpoint di progetto, non a quello per-repo.
    expect(postProjectDocChat).toHaveBeenCalledWith(PROJECT_SCOPE_ID, {
      sessionId: undefined,
      message: "how does billing relate to auth?",
    });
    expect(postDocChat).not.toHaveBeenCalled();

    // Le citazioni mostrano il nome del repository d'origine.
    expect(screen.getByText(/API ›/)).toBeInTheDocument();
    expect(screen.getByText(/Web ›/)).toBeInTheDocument();

    // I link puntano alla route per-repo col repositoryId della citazione.
    const authLink = await screen.findByRole("link", { name: /Authentication/ });
    const billingLink = await screen.findByRole("link", { name: /Billing/ });
    expect(authLink).toHaveAttribute("href", `/docs/${REPO_X}/auth`);
    expect(billingLink).toHaveAttribute("href", `/docs/${REPO_Y}/billing`);
  });
});
