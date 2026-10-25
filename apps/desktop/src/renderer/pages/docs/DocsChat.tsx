import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useAskDocs, useCitations, useSessionPersonId } from "../../data/queries";
import type { CitationRef, DocPageRef, DocsAnswer } from "../../data/types";
import { CloseIcon } from "../task/parts";
import { AssistantMessage, ClaudeHeader } from "../claude/conversation/AssistantMessage";
import {
  CitationLink,
  CitationProvider,
  indexCitations,
  refKey,
  useCitationIndex,
} from "../claude/conversation/citations";
import { UserMessage } from "../claude/conversation/EventList";
import { primaryButton, quietButton, SendGlyph, WorkingRing } from "../claude/conversation/parts";

// La chat dei Docs (shape docs.md §5, §6): del progetto (tutti i repository)
// o di un repository solo. Riusa i pezzi della conversazione dell'area 3 —
// messaggio di chi chiede, intestazione e testo di Claude in Markdown coi
// codici che diventano link, la riga «Used:» con le citazioni (R-E9: una
// pagina che chi guarda non legge più resta un codice tenue) — e la stessa
// casella. Vuota: 3–4 domande suggerite; «New chat» azzera. Senza un
// provider con chiave API la casella lascia il posto a «Chat isn't
// available». La conversazione vive finché vive chi la monta: cambiando
// persona si rimonta da zero.

interface Turn {
  id: string;
  question: string;
  /** `unavailable`: il provider è sparito a metà conversazione (non un errore da riprovare). */
  status: "pending" | "done" | "error" | "unavailable";
  answer?: DocsAnswer;
}

export interface DocsChatState {
  turns: Turn[];
  send: (question: string) => void;
  retry: (id: string) => void;
  reset: () => void;
  busy: boolean;
  /** Una risposta ha detto `chat_unavailable`: la casella lascia il posto all'avviso. */
  unavailable: boolean;
}

/** La conversazione di una chat dei Docs (domande, risposte, ripresa di un errore). */
export function useDocsChat({
  projectId,
  repositoryId,
}: {
  projectId: string;
  repositoryId?: string;
}): DocsChatState {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const seq = useRef(0);
  const ask = useAskDocs();
  const { mutateAsync } = ask;
  const patch = useCallback(
    (id: string, next: Partial<Turn>) =>
      setTurns((prev) => prev.map((turn) => (turn.id === id ? { ...turn, ...next } : turn))),
    [],
  );
  const run = useCallback(
    (id: string, question: string) => {
      patch(id, { status: "pending" });
      // Dopo «New chat» il turno non c'è più: `patch` non trova nulla e basta.
      mutateAsync({ projectId, ...(repositoryId ? { repositoryId } : {}), question }).then(
        (answer) => patch(id, { status: "done", answer }),
        (error: unknown) => {
          const lost = error instanceof Error && error.message === "chat_unavailable";
          // Il provider non torna con «New chat»: l'avviso resta finché vive la chat.
          if (lost) setUnavailable(true);
          patch(id, { status: lost ? "unavailable" : "error" });
        },
      );
    },
    [mutateAsync, patch, projectId, repositoryId],
  );
  const send = useCallback(
    (question: string) => {
      const id = `q${++seq.current}`;
      setTurns((prev) => [...prev, { id, question, status: "pending" }]);
      run(id, question);
    },
    [run],
  );
  const retry = useCallback(
    (id: string) => {
      const turn = turns.find((t) => t.id === id);
      if (turn) run(id, turn.question);
    },
    [run, turns],
  );
  const reset = useCallback(() => setTurns([]), []);
  return {
    turns,
    send,
    retry,
    reset,
    busy: turns.some((t) => t.status === "pending"),
    unavailable,
  };
}

/**
 * Il pannello della chat (agganciato 360 px, o sovrapposto 400 px sotto i
 * 1200): intestazione con «New chat» (e la chiusura, se c'è), la
 * conversazione o le domande suggerite, la casella in fondo.
 */
export function DocsChatPanel({
  chat,
  available,
  suggestions,
  scope,
  placeholder,
  onClose,
  autoFocus = false,
  className = "",
}: {
  /** Il fuoco va nella casella all'apertura (il pannello sovrapposto). */
  autoFocus?: boolean;
  chat: DocsChatState;
  available: boolean;
  suggestions: readonly DocPageRef[];
  /** Come si chiama il perimetro («AUD», «audin-app»). */
  scope: string;
  placeholder: string;
  onClose?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const count = chat.turns.length;
  // Il provider può sparire a metà sessione: allora vale come se non ci fosse mai stato.
  const canAsk = available && !chat.unavailable;
  const last = chat.turns.at(-1)?.status;
  // Una domanda o una risposta nuova: si va in fondo.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, last]);

  return (
    <aside
      aria-label={t("docs.chat.title")}
      data-docs-chat
      className={`flex min-h-0 flex-col bg-surface ${className}`}
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-rule pr-1.5 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {t("docs.chat.title")}
        </h2>
        {count > 0 && (
          <button type="button" className={`${quietButton} h-7`} onClick={chat.reset}>
            {t("docs.chat.newChat")}
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className={`${quietButton} h-7 w-7 px-0`}
            aria-label={t("docs.chat.close")}
            title={t("docs.chat.close")}
            onClick={onClose}
          >
            <CloseIcon size={16} />
          </button>
        )}
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {count === 0 ? (
          <ChatStart chat={chat} available={canAsk} suggestions={suggestions} scope={scope} />
        ) : (
          <Turns chat={chat} />
        )}
      </div>
      {canAsk ? (
        <DocsComposer
          placeholder={placeholder}
          disabled={chat.busy}
          onSend={chat.send}
          autoFocus={autoFocus}
          className="shrink-0 px-4 pt-2 pb-4"
        />
      ) : (
        <Unavailable className="shrink-0 border-t border-rule px-4 py-3" />
      )}
    </aside>
  );
}

/** «Chat isn't available»: al posto della casella, senza domande da scegliere. */
export function Unavailable({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <p role="status" className={`text-sm text-ink-muted ${className}`}>
      {t("docs.chat.unavailable")}
    </p>
  );
}

/** La chat vuota: cosa sa fare, e le domande suggerite come righe 36 px. */
export function ChatStart({
  chat,
  available,
  suggestions,
  scope,
}: {
  chat: DocsChatState;
  available: boolean;
  suggestions: readonly DocPageRef[];
  scope: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">{t("docs.chat.intro", { scope })}</p>
      {available && suggestions.length > 0 && (
        <ul aria-label={t("docs.chat.suggestions")} className="flex flex-col">
          {suggestions.map((page) => {
            const question = t("docs.chat.suggest", { title: page.title });
            return (
              <li key={page.id}>
                <button
                  type="button"
                  onClick={() => chat.send(question)}
                  className="flex min-h-9 w-full min-w-0 items-center rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                >
                  <span className="min-w-0">{question}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Turns({ chat }: { chat: DocsChatState }) {
  const me = useSessionPersonId();
  const refs: CitationRef[] = chat.turns.flatMap((turn) => turn.answer?.refs ?? []);
  const citations = useCitations(refs);
  return (
    <CitationProvider value={indexCitations(citations.data)}>
      <div className="flex flex-col gap-3">
        {chat.turns.map((turn) => (
          <div key={turn.id} className="flex flex-col gap-2">
            <UserMessage
              authorId={me}
              at={null}
              text={turn.question}
              attachments={[]}
              delivery={null}
            />
            <Answer turn={turn} onRetry={() => chat.retry(turn.id)} />
          </div>
        ))}
      </div>
    </CitationProvider>
  );
}

function Answer({ turn, onRetry }: { turn: Turn; onRetry: () => void }) {
  const { t } = useTranslation();
  if (turn.status === "pending") {
    return (
      <p role="status" className="flex items-center gap-2 pt-1 text-sm text-ink-muted">
        <WorkingRing size={12} />
        {t("docs.chat.reading")}
      </p>
    );
  }
  if (turn.status === "unavailable") {
    // Non è un errore da riprovare: l'avviso vero sta al posto della casella.
    return <p className="pt-1 text-sm text-ink-muted">{t("docs.chat.noAnswer")}</p>;
  }
  if (turn.status === "error" || !turn.answer) {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-x-2 pt-1 text-sm text-ink">
        {t("docs.chat.error")}
        <button
          type="button"
          onClick={onRetry}
          className="font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
        >
          {t("docs.chat.tryAgain")}
        </button>
      </p>
    );
  }
  const answer = turn.answer;
  return (
    <div className="flex flex-col gap-1.5">
      <ClaudeHeader at={answer.answeredAt} compact />
      <AssistantMessage
        item={{
          kind: "assistant",
          key: turn.id,
          event: {
            id: turn.id,
            at: answer.answeredAt,
            type: "assistant",
            text: answer.text,
            done: true,
          },
          refs: [],
        }}
        streaming={false}
      />
      <Sources answer={answer} />
    </div>
  );
}

/**
 * «Used:» con le pagine lette: codice + titolo (si aprono nella colonna di
 * lettura, la chat resta) e «from audin-app»; una pagina che chi guarda non
 * legge più è il codice tenue che non si apre (R-E9).
 */
function Sources({ answer }: { answer: DocsAnswer }) {
  const { t } = useTranslation();
  const index = useCitationIndex();
  const rows = answer.refs.flatMap((ref, i) => {
    const view = index.byRef.get(refKey(ref));
    return view ? [{ view, repo: answer.sources[i]?.repositoryName }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 text-sm text-ink-muted">
      <span>{t("claude.conversation.citation.used")}</span>
      {rows.map(({ view, repo }, i) => (
        <span key={refKey(view)} className="inline">
          <CitationLink view={view} />
          {view.visible && repo && (
            <span className="text-ink-faint"> {t("docs.chat.from", { repo })}</span>
          )}
          {i < rows.length - 1 && <span aria-hidden="true"> · </span>}
        </span>
      ))}
    </p>
  );
}

const MAX_LINES = 6;
const LINE_PX = 20;

/**
 * La casella della chat dei Docs: lo stesso aspetto di quella della
 * conversazione (bordo `rule-strong`, cresce con il testo), senza allegati
 * né menu: qui si fanno domande. Invio manda, Maiusc+Invio va a capo.
 */
export function DocsComposer({
  placeholder,
  disabled,
  onSend,
  className = "",
  autoFocus = false,
}: {
  placeholder: string;
  disabled: boolean;
  onSend: (text: string) => void;
  className?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES * LINE_PX + 16)}px`;
  }, [text]);
  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);
  const submit = () => {
    const question = text.trim();
    if (!question || disabled) return;
    onSend(question);
    setText("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className={className}>
      <div className="flex min-w-0 items-end gap-1.5 rounded-lg border border-rule-strong bg-surface p-1.5 transition-colors duration-[var(--duration-fast)] ease-out focus-within:border-ink/45">
        <textarea
          ref={field}
          rows={1}
          value={text}
          aria-label={t("docs.chat.field")}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="block max-h-[136px] min-h-8 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-md text-ink outline-none placeholder:text-ink-faint focus-visible:outline-none"
        />
        <button
          type="button"
          className={`${primaryButton} w-8 px-0`}
          disabled={!text.trim() || disabled}
          aria-label={t("docs.chat.send")}
          title={t("docs.chat.send")}
          onClick={submit}
        >
          <SendGlyph />
        </button>
      </div>
    </div>
  );
}
