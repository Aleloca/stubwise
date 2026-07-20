import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BacklogMessage } from "../lib/api";
import { ApiError } from "../lib/api";
import type { BacklogChatHandlers } from "../lib/backlog-chat-api";
import { setMatchMedia } from "../test/setup";
import { BacklogChat } from "./backlog-chat";

/**
 * Test della chat di raffinamento (Task 21). Mocka `postBacklogChatStream` per
 * pilotare gli handler (delta/done/error) o rigettare (503). Renderizzato in
 * modalità desktop (pannello inline) così la textarea è subito visibile.
 * Verifica: render incrementale, fonti dal `done`, storia iniziale, messaggi di
 * sistema come divider, 503 `chat_unavailable` con messaggio dedicato, e la
 * callback onExchangeComplete a fine scambio.
 */

const DESKTOP_QUERY = "(min-width: 1024px)";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";

const postBacklogChatStream = vi.fn();
vi.mock("../lib/backlog-chat-api", () => ({
  postBacklogChatStream: (...args: unknown[]) => postBacklogChatStream(...args),
}));

beforeEach(() => {
  // Desktop: la chat è un pannello inline, non un drawer.
  setMatchMedia(DESKTOP_QUERY, true);
});

afterEach(() => {
  postBacklogChatStream.mockReset();
});

function renderChat(initialMessages: BacklogMessage[] = [], onExchangeComplete = vi.fn()) {
  render(
    <BacklogChat
      itemId={ITEM_ID}
      initialMessages={initialMessages}
      onExchangeComplete={onExchangeComplete}
    />,
  );
  return { onExchangeComplete };
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  const input = screen.getByLabelText(/ask or refine/i);
  await user.type(input, text);
  await user.click(screen.getByRole("button", { name: /^send$/i }));
}

describe("BacklogChat", () => {
  it("stremma i delta e mostra le fonti dal done", async () => {
    postBacklogChatStream.mockImplementation(
      async (_id: string, _msg: string, handlers: BacklogChatHandlers) => {
        handlers.onDelta("Hello ");
        handlers.onDelta("world.");
        handlers.onDone({ citations: [{ title: "Doc A" }, { title: "Doc B" }] });
      },
    );

    const user = userEvent.setup();
    const { onExchangeComplete } = renderChat();

    await ask(user, "how to ship this?");

    expect(await screen.findByText("how to ship this?")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Hello world.")).toBeInTheDocument());
    // Le fonti compaiono come lista di titoli (forma semplificata).
    expect(screen.getByText("Doc A")).toBeInTheDocument();
    expect(screen.getByText("Doc B")).toBeInTheDocument();
    // A fine scambio il chiamante viene notificato (invalida il dettaglio).
    await waitFor(() => expect(onExchangeComplete).toHaveBeenCalled());
    // Il messaggio è arrivato con l'itemId + testo.
    expect(postBacklogChatStream).toHaveBeenCalledWith(
      ITEM_ID,
      "how to ship this?",
      expect.any(Object),
    );
  });

  it("evento error: mostra lo stato d'errore", async () => {
    postBacklogChatStream.mockImplementation(
      async (_id: string, _msg: string, handlers: BacklogChatHandlers) => {
        handlers.onDelta("partial");
        handlers.onError();
      },
    );

    const user = userEvent.setup();
    renderChat();
    await ask(user, "trigger error");

    expect(await screen.findByRole("alert")).toHaveTextContent(/went wrong/i);
  });

  it("503 chat_unavailable: messaggio dedicato, non il generico", async () => {
    postBacklogChatStream.mockRejectedValueOnce(
      new ApiError(503, "Backlog chat requires an API-key AI provider", "chat_unavailable"),
    );

    const user = userEvent.setup();
    renderChat();
    await ask(user, "any question");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/api-key ai provider/i);
    expect(alert).not.toHaveTextContent(/went wrong/i);
  });

  it("stream chiuso senza done: l'indicatore di attesa sparisce", async () => {
    // Il contratto: la promise risolve senza onDone/onError; lo stato streaming
    // si chiude alla risoluzione (finally), non dentro onDone.
    postBacklogChatStream.mockImplementation(
      async (_id: string, _msg: string, handlers: BacklogChatHandlers) => {
        handlers.onDelta("troncato");
      },
    );

    const user = userEvent.setup();
    renderChat();
    await ask(user, "q");

    expect(await screen.findByText("troncato")).toBeInTheDocument();
    // "Thinking…" nel bubble assistant sparisce; resta solo l'etichetta del bottone.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^send$/i })).toBeInTheDocument(),
    );
  });

  it("storia iniziale: rende utente/assistant e i messaggi di sistema come divider", async () => {
    const history: BacklogMessage[] = [
      { id: "m1", role: "user", content: "prima domanda", citations: null, createdAt: "2026-06-01T10:00:00.000Z" },
      { id: "m2", role: "assistant", content: "prima risposta", citations: null, createdAt: "2026-06-01T10:00:05.000Z" },
      { id: "m3", role: "system", content: "documento aggiornato", citations: null, createdAt: "2026-06-01T10:01:00.000Z" },
    ];
    renderChat(history);

    expect(screen.getByText("prima domanda")).toBeInTheDocument();
    expect(screen.getByText("prima risposta")).toBeInTheDocument();
    // Il messaggio di sistema è una nota/divider, non una bolla utente/assistant.
    const systemNote = screen.getByText("documento aggiornato");
    expect(systemNote.closest('[aria-label="system"]')).not.toBeNull();
  });

  it("stato vuoto: nessun messaggio finché non si invia", () => {
    renderChat();
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it("durante lo streaming l'invio è disabilitato (guardia sending)", async () => {
    // Stream pilotabile: la promise resta pendente finché il test non la rilascia.
    let release!: () => void;
    postBacklogChatStream.mockImplementation(
      (_id: string, _msg: string, handlers: BacklogChatHandlers) =>
        new Promise<void>((resolve) => {
          handlers.onDelta("in corso");
          release = () => {
            handlers.onDone({});
            resolve();
          };
        }),
    );

    const user = userEvent.setup();
    renderChat();
    await ask(user, "prima domanda");

    // Mentre lo stream è aperto il bottone mostra "Thinking…" ed è disabilitato:
    // un secondo invio non può partire.
    const thinking = await screen.findByRole("button", { name: /thinking/i });
    expect(thinking).toBeDisabled();
    expect(postBacklogChatStream).toHaveBeenCalledTimes(1);

    release();

    // A stream chiuso il bottone torna "Send" e si può scrivere di nuovo.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^send$/i })).toBeInTheDocument(),
    );
    await user.type(screen.getByLabelText(/ask or refine/i), "seconda");
    expect(screen.getByRole("button", { name: /^send$/i })).toBeEnabled();
  });
});
