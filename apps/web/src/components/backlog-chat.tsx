import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import type { BacklogMessage } from "../lib/api";
import { postBacklogChatStream } from "../lib/backlog-chat-api";
import { useMediaQuery } from "../lib/use-media-query";
import { Drawer } from "./drawer";
import { Markdown } from "./markdown";

/**
 * Chat di raffinamento di una voce del backlog (Task 21). Storia iniziale dal
 * dettaglio (`initialMessages`), poi ogni turno appende localmente un messaggio
 * utente e uno assistant che si compone in streaming via {@link
 * postBacklogChatStream}. Segue il pattern di {@link file://./docs-chat.tsx}:
 * pannello affiancato su desktop (`lg+`), drawer da destra su mobile.
 *
 * Contratto di chiusura dello stream: lo stream può chiudersi SENZA un `done`
 * esplicito (troncamento) — la promise risolve comunque, e chiudiamo lo stato
 * "streaming" alla risoluzione (nel `finally`), non dentro `onDone`, così
 * l'indicatore sparisce in ogni caso.
 *
 * Citazioni: il server le manda come jsonb opaco. A differenza della chat Docs
 * (ancorata a uno spazio) qui la voce non è legata a un singolo spazio doc, per
 * cui le rendiamo in forma SEMPLIFICATA — la sola lista dei titoli, senza link
 * (scelta documentata): estraiamo i `title` stringa e scartiamo il resto.
 */

/** Un messaggio della conversazione lato client (storia iniziale + append). */
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Titoli delle fonti citate (assistant), estratti dal payload `done`. */
  sources?: string[];
  /** Solo per l'assistant in corso: true mentre lo stream non è ancora chiuso. */
  streaming?: boolean;
  /** Solo per l'assistant: true se lo stream è terminato con un evento `error`. */
  errored?: boolean;
  /** Solo per l'assistant: true su 503 `chat_unavailable` (nessun provider api_key). */
  unavailable?: boolean;
}

/** Estrae i titoli-stringa da un payload di citazioni arbitrario (server permissivo). */
function parseSourceTitles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const title = (entry as Record<string, unknown>).title;
    return typeof title === "string" && title.length > 0 ? [title] : [];
  });
}

let localIdSeq = 0;
function nextLocalId(): string {
  localIdSeq += 1;
  return `local-${localIdSeq}`;
}

/** Mappa la storia dal dettaglio in messaggi locali (le citazioni → titoli). */
function fromHistory(messages: BacklogMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    sources: message.role === "assistant" ? parseSourceTitles(message.citations) : undefined,
  }));
}

export function BacklogChat({
  itemId,
  initialMessages,
  onExchangeComplete,
}: {
  itemId: string;
  /** Storia della conversazione dal GET dettaglio (una sola per voce). */
  initialMessages: BacklogMessage[];
  /**
   * Invocato alla fine di ogni scambio: il primo messaggio può portare lo stato
   * a `refining` lato server, quindi il chiamante invalida il dettaglio (a buon
   * mercato) per riconciliare i metadati.
   */
  onExchangeComplete: () => void;
}) {
  const { t } = useTranslation();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [open, setOpen] = useState(false);
  // Storia iniziale copiata UNA volta: gli append vivono qui e l'invalidazione
  // del dettaglio (onExchangeComplete) NON deve reidratare/duplicare la lista.
  const [messages, setMessages] = useState<ChatMessage[]>(() => fromHistory(initialMessages));
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Autoscroll in fondo a ogni nuovo frammento/messaggio.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function send() {
    const question = input.trim();
    if (!question || sending) return;

    const userMessage: ChatMessage = { id: nextLocalId(), role: "user", content: question };
    const assistantId = nextLocalId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      streaming: true,
    };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setSending(true);

    const patchAssistant = (patch: Partial<ChatMessage>) => {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)));
    };

    let accumulated = "";
    try {
      await postBacklogChatStream(itemId, question, {
        onDelta: (text) => {
          accumulated += text;
          patchAssistant({ content: accumulated });
        },
        onDone: ({ citations }) => {
          patchAssistant({ sources: parseSourceTitles(citations), streaming: false });
        },
        onError: () => {
          patchAssistant({ streaming: false, errored: true });
        },
      });
      // Stream chiuso (con o senza `done`): chiudi comunque lo stato streaming.
      patchAssistant({ streaming: false });
    } catch (error) {
      // Chat non servibile (503 `chat_unavailable`): pre-flight del server, lo
      // stream non si è mai aperto. Messaggio dedicato e attuabile.
      if (error instanceof ApiError && error.code === "chat_unavailable") {
        patchAssistant({ streaming: false, unavailable: true });
      } else {
        patchAssistant({ streaming: false, errored: true });
      }
    } finally {
      setSending(false);
      onExchangeComplete();
    }
  }

  const body = (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] tracking-[0.12em] text-fg uppercase">
            {t("backlog:chat.title")}
          </h2>
          <p className="mt-0.5 text-[11px] text-fg-faint">{t("backlog:chat.subtitle")}</p>
        </div>
        {!isDesktop && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t("backlog:chat.close")}
            className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.06em] text-fg-muted uppercase transition-colors hover:text-fg"
          >
            ✕
          </button>
        )}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
                {t("backlog:chat.emptyTitle")}
              </p>
              <p className="mt-2 text-[12px] text-fg-muted">{t("backlog:chat.emptyHint")}</p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-4">
            {messages.map((message) => (
              <ChatBubble key={message.id} message={message} />
            ))}
          </ul>
        )}
      </div>

      <form
        className="border-t border-line p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label htmlFor="backlog-chat-input" className="sr-only">
          {t("backlog:chat.placeholder")}
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="backlog-chat-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={t("backlog:chat.placeholder")}
            aria-label={t("backlog:chat.placeholder")}
            className="min-w-0 flex-1 resize-none rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-[13px] text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          />
          <button
            type="submit"
            disabled={sending || input.trim().length === 0}
            className="shrink-0 rounded-sm border border-line-strong px-3 py-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
          >
            {sending ? t("backlog:chat.thinking") : t("backlog:chat.send")}
          </button>
        </div>
      </form>
    </div>
  );

  // Desktop (`lg+`): pannello inline in colonna (altezza fissa, corpo scrollabile).
  if (isDesktop) {
    return (
      <section
        aria-label={t("backlog:chat.title")}
        className="flex h-[32rem] flex-col overflow-hidden rounded-sm border border-line bg-ink-900"
      >
        {body}
      </section>
    );
  }

  // Mobile: bottone che apre un drawer da destra a piena altezza.
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-sm border border-line-strong bg-ink-900 px-3 py-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
      >
        {t("backlog:chat.open")}
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        side="right"
        widthClassName="w-[min(92vw,28rem)]"
        aria-label={t("backlog:chat.title")}
        id="backlog-chat-drawer"
      >
        <div className="h-full bg-ink-950">{body}</div>
      </Drawer>
    </>
  );
}

/** Una bolla: utente (testo), assistant (markdown + fonti) o nota di sistema. */
function ChatBubble({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();

  // I messaggi di sistema non sono bolle: divider/nota centrata.
  if (message.role === "system") {
    return (
      <li className="flex items-center gap-3 py-1" aria-label="system">
        <span className="h-px flex-1 bg-line" aria-hidden />
        <span className="font-mono text-[10px] tracking-[0.08em] text-fg-faint">
          {message.content}
        </span>
        <span className="h-px flex-1 bg-line" aria-hidden />
      </li>
    );
  }

  const isUser = message.role === "user";
  return (
    <li className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
        {isUser ? t("backlog:chat.you") : t("backlog:chat.assistant")}
      </span>
      {isUser ? (
        <div className="rounded-sm border border-line-strong bg-ink-900 px-3 py-2 text-[13px] whitespace-pre-wrap text-fg">
          {message.content}
        </div>
      ) : (
        <div className="rounded-sm border border-line bg-ink-925 px-3 py-2">
          {message.unavailable ? (
            <p className="text-[13px] text-danger" role="alert">
              {t("backlog:chat.unavailable")}
            </p>
          ) : message.errored ? (
            <p className="text-[13px] text-danger" role="alert">
              {t("backlog:chat.error")}
            </p>
          ) : (
            <>
              {message.content ? <Markdown source={message.content} /> : null}
              {message.streaming && (
                <p
                  className="mt-1 font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase"
                  aria-live="polite"
                >
                  {t("backlog:chat.thinking")}
                </p>
              )}
              {message.sources && message.sources.length > 0 && (
                <div className="mt-3 border-t border-line pt-2">
                  <p className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
                    {t("backlog:chat.sources")}
                  </p>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {message.sources.map((title, index) => (
                      <li key={`${index}:${title}`} className="text-[12px] text-fg-muted">
                        {title}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
