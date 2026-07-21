import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BacklogCodeSession, BacklogMessage } from "../lib/api";
import { ApiError } from "../lib/api";
import type { BacklogChatHandlers } from "../lib/backlog-chat-api";
import { setMatchMedia } from "../test/setup";
import { BacklogChat } from "./backlog-chat";

/**
 * Test della chat di raffinamento a doppia modalità (Task 21 + sessione codice).
 * Mocka `postBacklogChatStream` (DOCS, streaming) e `postBacklogChatTurn` (CODE,
 * 202). Renderizzato in modalità desktop (pannello inline) così la textarea è
 * subito visibile. Verifica: render incrementale DOCS, fonti dal `done`, storia
 * iniziale, messaggi di sistema come divider, 503 `chat_unavailable`, callback
 * onExchangeComplete; badge modalità, avvio/chiusura sessione (picker repo se
 * >1), invio in modalità CODE (placeholder + arrivo risposta via merge server),
 * merge senza duplicati.
 */

const DESKTOP_QUERY = "(min-width: 1024px)";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const REPO_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REPO_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const REPOS = [
  { id: REPO_A, name: "Repo A" },
  { id: REPO_B, name: "Repo B" },
];
const ACTIVE_SESSION: BacklogCodeSession = {
  status: "active",
  repositoryId: REPO_A,
  startedAt: "2026-07-21T10:00:00.000Z",
};

const postBacklogChatStream = vi.fn();
vi.mock("../lib/backlog-chat-api", () => ({
  postBacklogChatStream: (...args: unknown[]) => postBacklogChatStream(...args),
}));

const postBacklogChatTurn = vi.fn();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    postBacklogChatTurn: (...args: unknown[]) => postBacklogChatTurn(...args),
  };
});

beforeEach(() => {
  // Desktop: la chat è un pannello inline, non un drawer.
  setMatchMedia(DESKTOP_QUERY, true);
});

afterEach(() => {
  postBacklogChatStream.mockReset();
  postBacklogChatTurn.mockReset();
});

interface ChatProps {
  serverMessages?: BacklogMessage[];
  onExchangeComplete?: ReturnType<typeof vi.fn>;
  codeSession?: BacklogCodeSession | null;
  pendingTurn?: boolean;
  repos?: { id: string; name: string }[];
  onStartSession?: ReturnType<typeof vi.fn>;
  onStopSession?: ReturnType<typeof vi.fn>;
  sessionPending?: boolean;
  sessionError?: string | null;
}

function renderChat(props: ChatProps = {}) {
  const onExchangeComplete = props.onExchangeComplete ?? vi.fn();
  const onStartSession = props.onStartSession ?? vi.fn();
  const onStopSession = props.onStopSession ?? vi.fn();
  const view = render(
    <BacklogChat
      itemId={ITEM_ID}
      serverMessages={props.serverMessages ?? []}
      onExchangeComplete={onExchangeComplete}
      codeSession={props.codeSession ?? null}
      pendingTurn={props.pendingTurn ?? false}
      repos={props.repos ?? REPOS}
      onStartSession={onStartSession}
      onStopSession={onStopSession}
      sessionPending={props.sessionPending ?? false}
      sessionError={props.sessionError ?? null}
    />,
  );
  return { onExchangeComplete, onStartSession, onStopSession, view };
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
    renderChat({ serverMessages: history });

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

  it("badge modalità: DOCS senza sessione, CODE — repo con sessione attiva", () => {
    const { view } = renderChat();
    expect(screen.getByText("DOCS")).toBeInTheDocument();
    expect(screen.queryByText(/CODE/)).not.toBeInTheDocument();

    view.rerender(
      <BacklogChat
        itemId={ITEM_ID}
        serverMessages={[]}
        onExchangeComplete={vi.fn()}
        codeSession={ACTIVE_SESSION}
        pendingTurn={false}
        repos={REPOS}
        onStartSession={vi.fn()}
        onStopSession={vi.fn()}
        sessionPending={false}
      />,
    );
    expect(screen.getByText("CODE — Repo A")).toBeInTheDocument();
    expect(screen.queryByText("DOCS")).not.toBeInTheDocument();
  });

  it("avvio sessione: repo singolo → start diretto senza dialog", async () => {
    const user = userEvent.setup();
    const { onStartSession } = renderChat({ repos: [{ id: REPO_A, name: "Repo A" }] });

    await user.click(screen.getByRole("button", { name: /start analysis session/i }));

    expect(onStartSession).toHaveBeenCalledWith(REPO_A);
    // Nessuna dialog aperta per repo singolo.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("avvio sessione: multi-repo → dialog di scelta, poi start col repo scelto", async () => {
    const user = userEvent.setup();
    const { onStartSession } = renderChat({ repos: REPOS });

    await user.click(screen.getByRole("button", { name: /start analysis session/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Scelgo Repo B e confermo.
    await user.selectOptions(screen.getByRole("combobox"), REPO_B);
    await user.click(screen.getByRole("button", { name: /^start session$/i }));

    expect(onStartSession).toHaveBeenCalledWith(REPO_B);
  });

  it("chiusura sessione: il bottone invoca onStopSession", async () => {
    const user = userEvent.setup();
    const { onStopSession } = renderChat({ codeSession: ACTIVE_SESSION });

    await user.click(screen.getByRole("button", { name: /close session/i }));
    expect(onStopSession).toHaveBeenCalledTimes(1);
  });

  it("invio in modalità CODE: 202 + placeholder, poi risposta via merge server, senza duplicati", async () => {
    const serverUserId = "99999999-9999-4999-8999-999999999999";
    postBacklogChatTurn.mockResolvedValue({ mode: "code", userMessageId: serverUserId });

    const user = userEvent.setup();
    const { view } = renderChat({ codeSession: ACTIVE_SESSION, serverMessages: [] });

    await ask(user, "come funziona il login?");

    // Messaggio utente ottimistico + placeholder "sta investigando…".
    expect(await screen.findByText("come funziona il login?")).toBeInTheDocument();
    expect(screen.getByText(/investigating the code/i)).toBeInTheDocument();
    // Niente streaming SSE in modalità code.
    expect(postBacklogChatStream).not.toHaveBeenCalled();
    expect(postBacklogChatTurn).toHaveBeenCalledWith(ITEM_ID, "come funziona il login?");

    // Il worker completa il turno: il GET dettaglio rifetchato porta il messaggio
    // utente persistito (stesso id del 202) E la risposta dell'assistant.
    const merged: BacklogMessage[] = [
      {
        id: serverUserId,
        role: "user",
        content: "come funziona il login?",
        citations: null,
        createdAt: "2026-07-21T10:01:00.000Z",
      },
      {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        role: "assistant",
        content: "Il login usa i cookie di sessione.",
        citations: null,
        createdAt: "2026-07-21T10:02:00.000Z",
      },
    ];
    view.rerender(
      <BacklogChat
        itemId={ITEM_ID}
        serverMessages={merged}
        onExchangeComplete={vi.fn()}
        codeSession={ACTIVE_SESSION}
        pendingTurn={false}
        repos={REPOS}
        onStartSession={vi.fn()}
        onStopSession={vi.fn()}
        sessionPending={false}
      />,
    );

    // La risposta compare e il placeholder sparisce.
    expect(await screen.findByText("Il login usa i cookie di sessione.")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/investigating the code/i)).not.toBeInTheDocument(),
    );
    // Il messaggio utente NON è duplicato (dedup per userMessageId del 202).
    expect(screen.getAllByText("come funziona il login?")).toHaveLength(1);
  });

  it("merge: un messaggio system nuovo dal server compare una sola volta", () => {
    const { view } = renderChat({ codeSession: ACTIVE_SESSION, serverMessages: [] });

    const system: BacklogMessage = {
      id: "bbbbbbbb-0000-4000-8000-000000000002",
      role: "system",
      content: "Sessione di analisi avviata su Repo A.",
      citations: null,
      createdAt: "2026-07-21T10:00:05.000Z",
    };
    const rerenderWith = (messages: BacklogMessage[]) =>
      view.rerender(
        <BacklogChat
          itemId={ITEM_ID}
          serverMessages={messages}
          onExchangeComplete={vi.fn()}
          codeSession={ACTIVE_SESSION}
          pendingTurn={false}
          repos={REPOS}
          onStartSession={vi.fn()}
          onStopSession={vi.fn()}
          sessionPending={false}
        />,
      );

    rerenderWith([system]);
    expect(screen.getByText("Sessione di analisi avviata su Repo A.")).toBeInTheDocument();
    // Un secondo refetch con lo stesso messaggio non lo duplica.
    rerenderWith([system]);
    expect(screen.getAllByText("Sessione di analisi avviata su Repo A.")).toHaveLength(1);
  });

  it("pendingTurn senza placeholder locale (reload a turno in volo) mostra l'indicatore", () => {
    renderChat({
      codeSession: ACTIVE_SESSION,
      pendingTurn: true,
      serverMessages: [
        {
          id: "cccccccc-0000-4000-8000-000000000003",
          role: "user",
          content: "domanda in corso",
          citations: null,
          createdAt: "2026-07-21T10:00:00.000Z",
        },
      ],
    });
    expect(screen.getByText("domanda in corso")).toBeInTheDocument();
    expect(screen.getByText(/investigating the code/i)).toBeInTheDocument();
  });
});
