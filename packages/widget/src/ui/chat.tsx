/**
 * Corpo della chat: lista messaggi + composer. Orchestra l'invio di un messaggio
 * e il consumo dello stream SSE, la creazione LAZY della conversazione al primo
 * invio, e l'inserimento delle card ticket dalle proposte.
 *
 * La conversazione si crea al primo messaggio (non all'apertura): finché l'utente
 * non scrive, mostriamo solo il `welcomeMessage` come messaggio assistant fittizio
 * (non persistito lato server). L'id di conversazione vive in uno slot mutabile
 * (`ref`) e viene salvato in storage appena creato.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import {
  WidgetApiError,
  confirmTicket,
  createConversation,
  fetchMessages,
  sendMessage,
  type WidgetApiBase,
  type WidgetUser,
} from "../core/api.js";
import { parseSseStream, type WidgetCitation, type WidgetTicketProposal } from "../core/sse.js";
import { clearConversationId, setConversationId } from "../core/storage.js";
import type { WidgetStrings } from "../i18n.js";
import { TicketCard } from "./ticket-card.js";

/** Un elemento della timeline della chat. */
export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; citations: WidgetCitation[] }
  | { kind: "ticket"; id: string; proposal: WidgetTicketProposal };

export interface ChatProps {
  base: WidgetApiBase;
  user: WidgetUser;
  strings: WidgetStrings;
  /** Messaggio di benvenuto (fittizio) se non c'è storico da caricare. */
  welcomeMessage: string;
  /** Composer attivo solo se la chat è abilitata lato config. */
  chatEnabled: boolean;
  /** conversationId iniziale da storage (o null: nuova conversazione lazy). */
  initialConversationId: string | null;
}

/** Titolo di una citazione, o null se il campo manca/non è stringa. */
function citationTitle(c: WidgetCitation): string | null {
  const t = c["title"];
  return typeof t === "string" ? t : null;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `m${idCounter}`;
}

export function Chat({
  base,
  user,
  strings,
  welcomeMessage,
  chatEnabled,
  initialConversationId,
}: ChatProps) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const conversationId = useRef<string | null>(initialConversationId);
  const messagesRef = useRef<HTMLDivElement>(null);

  // Carica lo storico se c'è un id salvato; altrimenti mostra il welcome fittizio.
  // 404 → la conversazione è stata persa/purgata lato server: la si dimentica e
  // si riparte da zero.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const id = conversationId.current;
      if (!id) {
        setItems([{ kind: "assistant", id: nextId(), text: welcomeMessage, citations: [] }]);
        return;
      }
      try {
        const { messages } = await fetchMessages(base, id, user.id);
        if (cancelled) return;
        setItems(
          messages.map((m) =>
            m.role === "user"
              ? { kind: "user", id: m.id, text: m.content }
              : {
                  kind: "assistant",
                  id: m.id,
                  text: m.content,
                  citations: Array.isArray(m.citations) ? m.citations : [],
                },
          ),
        );
      } catch (err) {
        if (cancelled) return;
        if (err instanceof WidgetApiError && err.status === 404) {
          conversationId.current = null;
          clearConversationId(base.slug);
          setItems([{ kind: "assistant", id: nextId(), text: welcomeMessage, citations: [] }]);
        } else {
          setItems([{ kind: "assistant", id: nextId(), text: welcomeMessage, citations: [] }]);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // Solo al mount: lo storico si carica una volta per apertura del pannello
    // (il pannello si smonta/rimonta all'apri/chiudi). Le dipendenze sono stabili.
  }, []);

  // Autoscroll in fondo a ogni cambiamento della timeline.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  /** Assicura una conversazione (crea lazy al primo invio, poi la persiste). */
  async function ensureConversation(): Promise<string> {
    if (conversationId.current) return conversationId.current;
    const { conversationId: id } = await createConversation(base, user);
    conversationId.current = id;
    setConversationId(base.slug, id);
    return id;
  }

  async function send() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    setStreaming(true);

    const userItem: ChatItem = { kind: "user", id: nextId(), text };
    const assistantId = nextId();
    setItems((prev) => [
      ...prev,
      userItem,
      { kind: "assistant", id: assistantId, text: "", citations: [] },
    ]);

    /** Aggiorna in-place il messaggio assistant in corso. */
    function patchAssistant(fn: (a: Extract<ChatItem, { kind: "assistant" }>) => ChatItem) {
      setItems((prev) =>
        prev.map((it) => (it.kind === "assistant" && it.id === assistantId ? fn(it) : it)),
      );
    }

    try {
      const id = await ensureConversation();
      const response = await sendMessage(base, id, { content: text, userId: user.id });
      await parseSseStream(response, (event) => {
        if (event.type === "delta") {
          patchAssistant((a) => ({ ...a, text: a.text + event.text }));
        } else if (event.type === "ticket_proposal") {
          setItems((prev) => [
            ...prev,
            { kind: "ticket", id: nextId(), proposal: event.proposal },
          ]);
        } else if (event.type === "done") {
          patchAssistant((a) => ({ ...a, citations: event.citations }));
        } else if (event.type === "error") {
          patchAssistant((a) => ({ ...a, text: a.text || strings.errorGeneric }));
        }
      });
    } catch (err) {
      // Cap giornaliero raggiunto (429 widget_chat_cap_reached) → messaggio
      // dedicato; qualunque altro errore (HTTP o rete) → messaggio generico.
      const capReached =
        err instanceof WidgetApiError &&
        (err.status === 429 || err.code === "widget_chat_cap_reached");
      patchAssistant((a) => ({
        ...a,
        text: capReached ? strings.errorCapReached : strings.errorGeneric,
      }));
    } finally {
      setStreaming(false);
    }
  }

  /** Conferma un ticket (proposta editata) e ritorna il number per la card. */
  async function onConfirmTicket(
    proposal: WidgetTicketProposal,
    input: { title: string; body: string },
  ): Promise<{ number: number }> {
    const id = await ensureConversation();
    const { number } = await confirmTicket(base, id, {
      title: input.title,
      body: input.body,
      type: proposal.type,
      userId: user.id,
    });
    return { number };
  }

  /** Rimuove la card ticket annullata (la conversazione prosegue). */
  function removeTicket(ticketId: string) {
    setItems((prev) => prev.filter((it) => it.id !== ticketId));
  }

  return (
    <>
      <div class="sw-messages" ref={messagesRef}>
        {items.map((it) => {
          if (it.kind === "ticket") {
            return (
              <TicketCard
                key={it.id}
                proposal={it.proposal}
                strings={strings}
                onConfirm={(input) => onConfirmTicket(it.proposal, input)}
                onCancel={() => removeTicket(it.id)}
              />
            );
          }
          if (it.kind === "user") {
            return (
              <div key={it.id} class="sw-msg sw-msg-user">
                {it.text}
              </div>
            );
          }
          return (
            <div key={it.id}>
              <div class="sw-msg sw-msg-assistant">{it.text}</div>
              {it.citations.map((c, i) => {
                const title = citationTitle(c);
                return title ? (
                  <div key={i} class="sw-citation">
                    {strings.sourcePrefix} {title}
                  </div>
                ) : null;
              })}
            </div>
          );
        })}
      </div>

      {chatEnabled ? (
        <div class="sw-composer">
          <textarea
            class="sw-composer-input"
            rows={1}
            value={draft}
            placeholder={strings.composerPlaceholder}
            disabled={streaming}
            onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            class="sw-btn"
            disabled={streaming || draft.trim().length === 0}
            aria-label={strings.send}
            onClick={() => void send()}
          >
            {strings.send}
          </button>
        </div>
      ) : (
        <div class="sw-composer">
          <div class="sw-composer-note">{strings.chatDisabledNote}</div>
        </div>
      )}
    </>
  );
}
