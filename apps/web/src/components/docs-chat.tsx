import type { DocPageKind } from "@stubwise/shared";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import { type DocChatCitation, postDocChat } from "../lib/docs-api";
import { useMediaQuery } from "../lib/use-media-query";
import { Drawer } from "./drawer";
import { Markdown } from "./markdown";

/**
 * Widget chat RAG dello spazio (M7.5): un drawer nella zona destra dello spazio
 * Docs. L'utente fa una domanda, il widget POSTa via `postDocChat` e legge lo
 * stream SSE (`text/event-stream`) INCREMENTALMENTE — un evento `delta` per
 * frammento appeso al messaggio assistant in corso (render live), poi un evento
 * `done` con le citazioni (e il `sessionId`, persistito per il multi-turn), o un
 * evento `error` che mostra lo stato d'errore.
 *
 * Distinto dalla ricerca (M7.4): la ricerca linka pagine, la chat genera una
 * risposta in linguaggio naturale ancorata ai docs con citazioni cliccabili.
 * Scopato per-progetto (cross-project è future).
 */

/** Un messaggio della conversazione lato client (lo storico è solo in memoria). */
interface ChatMessage {
  /** Chiave React stabile: i messaggi non si riordinano, l'indice basterebbe ma
   * un id locale è più robusto agli append concorrenti. */
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: DocChatCitation[] | null;
  /** Solo per l'assistant in corso: true mentre lo stream non è ancora `done`. */
  streaming?: boolean;
  /** Solo per l'assistant: true se lo stream è terminato con un evento `error`. */
  errored?: boolean;
  /**
   * Solo per l'assistant: true se la chat NON è servibile (503 `chat_unavailable`
   * dal pre-flight: nessun provider AI `api_key` configurato). Distinto da
   * `errored` perché ha una causa attuabile dall'admin, con un messaggio dedicato.
   */
  unavailable?: boolean;
}

/** Evento SSE parsato dallo stream della chat (union discriminata su `type`). */
type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "done"; sessionId?: string; citations?: unknown }
  | { type: "error"; message?: string };

/** Forma minima di una citazione valida da renderizzare (guard anti-malformati). */
function isCitation(value: unknown): value is DocChatCitation {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.slug === "string" && c.slug.length > 0 && typeof c.title === "string";
}

/** Estrae le citazioni valide da un payload `done` arbitrario (server permissivo). */
function parseCitations(value: unknown): DocChatCitation[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isCitation);
}

let localIdSeq = 0;
function nextLocalId(): string {
  localIdSeq += 1;
  return `local-${localIdSeq}`;
}

export function DocsChat({
  projectId,
  open: openProp,
  onOpenChange,
}: {
  projectId: string;
  /** Stato aperto controllato (sub-barra Docs); se assente, è gestito internamente. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  // Su `lg+` la chat è una colonna affiancata; sotto, un drawer da destra. Si
  // pilota in JS (non solo via classi CSS) per montare UN SOLO corpo chat alla
  // volta: due istanze condividerebbero `id`/label e romperebbero le query.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  // Aperto controllato dal parent (sub-barra) o gestito internamente (FAB
  // standalone). In modalità controllata `openProp`/`onOpenChange` vincono.
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  // Setter stabile: il `Drawer` ha `onClose` nelle deps del suo effect; un
  // closure inline (nuova identità a ogni render → a ogni keystroke) gli farebbe
  // ri-rubare il focus dal textarea mentre si scrive. `useCallback` lo evita.
  const setOpen = useCallback(
    (value: boolean) => {
      setOpenState(value);
      onOpenChange?.(value);
    },
    [onOpenChange],
  );
  const closeChat = useCallback(() => setOpen(false), [setOpen]);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  // sessionId stabilito dal primo `done` (echo del server): riusato nei turni
  // successivi per il multi-turn. In un ref così l'handler dello stream legge
  // sempre l'ultimo valore senza ricreare la closure.
  const sessionIdRef = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Autoscroll in fondo a ogni nuovo frammento/messaggio.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function send() {
    const question = input.trim();
    if (!question || sending) return;

    const userMessage: ChatMessage = {
      id: nextLocalId(),
      role: "user",
      content: question,
      citations: null,
    };
    const assistantId = nextLocalId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      citations: null,
      streaming: true,
    };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setSending(true);

    /** Aggiorna il messaggio assistant in corso (per id). */
    const patchAssistant = (patch: Partial<ChatMessage>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)),
      );
    };

    try {
      const response = await postDocChat(projectId, {
        sessionId: sessionIdRef.current,
        message: question,
      });
      const body = response.body;
      if (!body) throw new Error("missing response body");

      // Lettura incrementale: decodifico i chunk, bufferizzo e taglio sui
      // separatori SSE `\n\n`. Ogni evento completo è una riga `data: {json}`.
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex: number;
        // Processa tutti gli eventi completi presenti nel buffer.
        while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const json = line.slice("data:".length).trim();
          if (!json) continue;

          let event: ChatEvent;
          try {
            event = JSON.parse(json) as ChatEvent;
          } catch {
            // Frammento non parsabile: lo ignoro invece di rompere lo stream.
            continue;
          }

          if (event.type === "delta") {
            accumulated += event.text;
            patchAssistant({ content: accumulated });
          } else if (event.type === "done") {
            if (event.sessionId) sessionIdRef.current = event.sessionId;
            patchAssistant({
              citations: parseCitations(event.citations),
              streaming: false,
            });
          } else if (event.type === "error") {
            patchAssistant({ streaming: false, errored: true });
          }
        }
      }

      // Stream chiuso senza un `done` esplicito (es. troncamento): chiudi lo
      // stato di streaming così l'indicatore sparisce.
      patchAssistant({ streaming: false });
    } catch (error) {
      // Chat non servibile (503 `chat_unavailable`): pre-flight del server, mai
      // si è aperto lo stream. Messaggio dedicato e attuabile (configura un
      // provider API key) invece del generico stato d'errore.
      if (error instanceof ApiError && error.code === "chat_unavailable") {
        patchAssistant({ streaming: false, unavailable: true });
      } else {
        patchAssistant({ streaming: false, errored: true });
      }
    } finally {
      setSending(false);
    }
  }

  // Corpo della chat (header + messaggi + form): identico nelle due varianti
  // di contenitore (colonna desktop / drawer mobile), nessuna duplicazione.
  const body = (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="font-mono text-[11px] tracking-[0.12em] text-fg uppercase">
            {t("docs:chat.title")}
          </h2>
          <p className="mt-0.5 text-[11px] text-fg-faint">{t("docs:chat.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t("docs:chat.close")}
          className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.06em] text-fg-muted uppercase transition-colors hover:text-fg"
        >
          ✕
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <p className="font-mono text-[11px] tracking-[0.12em] text-fg-faint uppercase">
                {t("docs:chat.emptyTitle")}
              </p>
              <p className="mt-2 text-[12px] text-fg-muted">{t("docs:chat.emptyHint")}</p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-4">
            {messages.map((message) => (
              <ChatBubble key={message.id} projectId={projectId} message={message} />
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
        <label htmlFor="docs-chat-input" className="sr-only">
          {t("docs:chat.placeholder")}
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="docs-chat-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // Enter invia, Shift+Enter va a capo.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={t("docs:chat.placeholder")}
            aria-label={t("docs:chat.placeholder")}
            className="min-w-0 flex-1 resize-none rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-[13px] text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          />
          <button
            type="submit"
            disabled={sending || input.trim().length === 0}
            className="shrink-0 rounded-sm border border-line-strong px-3 py-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
          >
            {sending ? t("docs:chat.thinking") : t("docs:chat.send")}
          </button>
        </div>
      </form>
    </div>
  );

  return (
    <>
      {/* FAB: apre la chat. Visibile (sia su desktop sia su mobile) quando chiusa. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="absolute right-4 bottom-4 z-20 rounded-sm border border-line-strong bg-ink-900 px-3 py-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
        >
          {t("docs:chat.open")}
        </button>
      )}

      {/* Desktop (`lg+`): colonna affiancata. Mobile: drawer da destra a piena
          altezza. Si monta una sola variante per non duplicare il corpo chat. */}
      {isDesktop ? (
        open && (
          <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-ink-950">
            {body}
          </aside>
        )
      ) : (
        <Drawer
          open={open}
          onClose={closeChat}
          side="right"
          widthClassName="w-[min(92vw,28rem)]"
          aria-label={t("docs:chat.title")}
          id="docs-chat-drawer"
        >
          <div className="h-full bg-ink-950">{body}</div>
        </Drawer>
      )}
    </>
  );
}

/** Una bolla della conversazione: utente (testo) o assistant (markdown + fonti). */
function ChatBubble({
  projectId,
  message,
}: {
  projectId: string;
  message: ChatMessage;
}) {
  const { t } = useTranslation();
  const isUser = message.role === "user";

  return (
    <li className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
        {isUser ? t("docs:chat.you") : t("docs:chat.assistant")}
      </span>
      {isUser ? (
        <div className="rounded-sm border border-line-strong bg-ink-900 px-3 py-2 text-[13px] whitespace-pre-wrap text-fg">
          {message.content}
        </div>
      ) : (
        <div className="rounded-sm border border-line bg-ink-925 px-3 py-2">
          {message.unavailable ? (
            <p className="text-[13px] text-danger" role="alert">
              {t("docs:chat.unavailable")}
            </p>
          ) : message.errored ? (
            <p className="text-[13px] text-danger" role="alert">
              {t("docs:chat.error")}
            </p>
          ) : (
            <>
              {message.content ? (
                <Markdown source={message.content} />
              ) : null}
              {message.streaming && (
                <p
                  className="mt-1 font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase"
                  aria-live="polite"
                >
                  {t("docs:chat.thinking")}
                </p>
              )}
              {message.citations && message.citations.length > 0 && (
                <Citations projectId={projectId} citations={message.citations} />
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

const KIND_LABEL_KEY: Record<DocPageKind, string> = {
  technical: "docs:search.kindTechnical",
  functional: "docs:search.kindFunctional",
  manual: "docs:search.kindManual",
};

/** Le citazioni del `done`: link cliccabili alla pagina sorgente (slug). */
function Citations({
  projectId,
  citations,
}: {
  projectId: string;
  citations: DocChatCitation[];
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 border-t border-line pt-2">
      <p className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase">
        {t("docs:chat.sources")}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {citations.map((citation) => (
          <li key={citation.slug}>
            <Link
              to="/docs/$projectId/$slug"
              params={{ projectId, slug: citation.slug }}
              className="inline-flex items-baseline gap-2 text-[12px] text-signal-dim hover:text-fg"
            >
              <span className="truncate">{citation.title}</span>
              {citation.kind && KIND_LABEL_KEY[citation.kind] && (
                <span className="shrink-0 font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase">
                  {t(KIND_LABEL_KEY[citation.kind])}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
