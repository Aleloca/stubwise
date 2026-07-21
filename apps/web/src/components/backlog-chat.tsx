import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../lib/api";
import type { BacklogCodeSession, BacklogMessage } from "../lib/api";
import { postBacklogChatStream } from "../lib/backlog-chat-api";
import { postBacklogChatTurn } from "../lib/api";
import { useMediaQuery } from "../lib/use-media-query";
import { Drawer } from "./drawer";
import { Markdown } from "./markdown";

/**
 * Chat di raffinamento di una voce del backlog (Task 21) a DOPPIA MODALITÀ.
 *
 * - **DOCS** (default, nessuna sessione attiva): chat RAG streaming sulla
 *   documentazione. Ogni turno appende localmente un messaggio utente e uno
 *   assistant che si compone in streaming via {@link postBacklogChatStream}.
 * - **CODE** (sessione di analisi attiva): ogni messaggio è un turno ASINCRONO
 *   dell'agente sul repo. L'invio fa un POST non-SSE ({@link postBacklogChatTurn})
 *   che risponde `202 {userMessageId}`; la risposta dell'assistant arriva DOPO
 *   (30–120s) via il GET dettaglio rifetchato dal chiamante (polling su
 *   `pendingTurn`), non in streaming. Mostriamo intanto una bolla placeholder
 *   "sta investigando nel codice…".
 *
 * Segue il pattern di {@link file://./docs-chat.tsx}: pannello affiancato su
 * desktop (`lg+`), drawer da destra su mobile.
 *
 * ## Strategia di merge/dedup dei messaggi dal server
 *
 * La chat mantiene una lista locale `messages` (display), seminata UNA volta da
 * `serverMessages` (storia dal GET dettaglio). Gli append locali hanno id
 * `local-N`; i messaggi persistiti dal server hanno UUID. A ogni cambiamento di
 * `serverMessages` (refetch) riconciliamo i messaggi server non ancora visti:
 *
 * 1. Teniamo un Set di id server GIÀ rappresentati localmente
 *    (`reconciledServerIds`), seminato con gli id della storia iniziale.
 * 2. **Utente in modalità CODE**: al 202 registriamo `userMessageId` nel Set →
 *    la copia persistita del messaggio utente NON viene ri-appesa (dedup per id
 *    del 202, deterministico).
 * 3. **Utente/assistant in modalità DOCS**: non abbiamo l'id server (lo stream
 *    non lo restituisce) → euristica su ruolo+contenuto: un messaggio server
 *    viene "adottato" da un append locale non ancora riconciliato con stesso
 *    ruolo e stesso contenuto (per l'assistant: il testo streammato è prefisso
 *    del persistito, così il marker di troncamento non genera un duplicato).
 *    All'adozione fissiamo `serverId` sul locale e registriamo l'id nel Set.
 * 4. **Risposte dei turni CODE, messaggi system (avvio/chiusura sessione,
 *    "documento aggiornato", scadenza)**: nessun append locale corrispondente →
 *    appesi in coda. All'arrivo di un assistant server nuovo rimuoviamo la bolla
 *    placeholder "sta investigando…" (il turno è completo).
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
  /** Id server del messaggio, una volta noto (adozione/202): guida il dedup. */
  serverId?: string;
  /** Titoli delle fonti citate (assistant), estratti dal payload `done`. */
  sources?: string[];
  /** Solo per l'assistant in corso: true mentre lo stream non è ancora chiuso. */
  streaming?: boolean;
  /** Placeholder CODE ("sta investigando…"): rimosso quando arriva la risposta. */
  placeholder?: boolean;
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

/** Mappa un messaggio dal dettaglio in un messaggio locale (le citazioni → titoli). */
function fromServerMessage(message: BacklogMessage): ChatMessage {
  return {
    id: message.id,
    serverId: message.id,
    role: message.role,
    content: message.content,
    sources: message.role === "assistant" ? parseSourceTitles(message.citations) : undefined,
  };
}

/** Mappa la storia dal dettaglio in messaggi locali. */
function fromHistory(messages: BacklogMessage[]): ChatMessage[] {
  return messages.map(fromServerMessage);
}

/**
 * Un append locale è "adottabile" da un messaggio server (stesso scambio
 * persistito) se non ha ancora un `serverId`, non è un placeholder e i ruoli e
 * il contenuto combaciano. Per l'assistant il testo streammato è prefisso del
 * persistito (il troncamento aggiunge un marker) → confronto per prefisso.
 */
function isReconciliation(server: BacklogMessage, local: ChatMessage): boolean {
  if (local.serverId || local.placeholder) return false;
  if (!local.id.startsWith("local-")) return false;
  if (server.role !== local.role) return false;
  if (local.role === "assistant") {
    return local.content.length > 0 && server.content.startsWith(local.content);
  }
  return local.content === server.content;
}

export function BacklogChat({
  itemId,
  serverMessages,
  onExchangeComplete,
  codeSession,
  pendingTurn,
  repos,
  onStartSession,
  onStopSession,
  sessionPending,
  sessionError,
}: {
  itemId: string;
  /** Storia/aggiornamenti della conversazione dal GET dettaglio (live, ri-fetchato). */
  serverMessages: BacklogMessage[];
  /**
   * Invocato alla fine di ogni scambio: il primo messaggio può portare lo stato
   * a `refining` lato server, quindi il chiamante invalida il dettaglio (a buon
   * mercato) per riconciliare i metadati.
   */
  onExchangeComplete: () => void;
  /** Sessione di analisi attiva (o null → modalità DOCS). */
  codeSession: BacklogCodeSession | null;
  /** True mentre un turno di analisi è in corso lato worker. */
  pendingTurn: boolean;
  /** Repository del progetto (per il nome nel badge e il picker di avvio). */
  repos: { id: string; name: string }[];
  /** Avvia una sessione sul repo scelto (mutazione gestita dal chiamante). */
  onStartSession: (repositoryId: string) => void;
  /** Chiude la sessione attiva (mutazione gestita dal chiamante). */
  onStopSession: () => void;
  /** True mentre una start/stop di sessione è in volo (disabilita i controlli). */
  sessionPending: boolean;
  /** Messaggio d'errore di start/stop sessione, o null. */
  sessionError?: string | null;
}) {
  const { t } = useTranslation();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [open, setOpen] = useState(false);
  // Storia iniziale copiata UNA volta: gli append vivono qui. Le novità dal
  // server (turni CODE, system) le integra l'effetto di riconciliazione sotto.
  const [messages, setMessages] = useState<ChatMessage[]>(() => fromHistory(serverMessages));
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Id server già rappresentati localmente (storia iniziale + adozioni + 202):
  // il merge non li ri-appende. Ref (non state): muta nell'effetto senza render.
  const reconciledServerIds = useRef<Set<string>>(
    new Set(serverMessages.map((message) => message.id)),
  );
  // Scroll pinning: l'autoscroll segue lo stream SOLO se l'utente è agganciato
  // al fondo. Se scrolla verso l'alto per leggere durante lo streaming, non lo
  // trasciniamo giù a ogni delta; il follow riprende quando torna vicino al
  // fondo o invia un nuovo messaggio. Ref (non state): cambia a ogni scroll o
  // delta e non deve causare re-render.
  const pinnedRef = useRef(true);

  const inCodeMode = codeSession !== null;
  const hasPlaceholder = messages.some((message) => message.placeholder);
  // Turno in corso: c'è un placeholder locale (appena inviato) o il server
  // segnala `pendingTurn` (es. pagina ricaricata a turno in volo).
  const turnInFlight = inCodeMode && (pendingTurn || hasPlaceholder);

  // Riconciliazione: integra i messaggi server non ancora visti (vedi doc in
  // testa al file). Gira a ogni cambiamento della lista server (refetch).
  useEffect(() => {
    setMessages((prev) => {
      const next = prev.map((message) => ({ ...message }));
      const adoptedIdx = new Set<number>();
      const toAppend: ChatMessage[] = [];
      let dropPlaceholder = false;
      let changed = false;

      for (const server of serverMessages) {
        if (reconciledServerIds.current.has(server.id)) continue;
        reconciledServerIds.current.add(server.id);
        changed = true;
        const idx = next.findIndex(
          (message, i) => !adoptedIdx.has(i) && isReconciliation(server, message),
        );
        if (idx >= 0) {
          adoptedIdx.add(idx);
          const local = next[idx]!;
          local.serverId = server.id;
          if (server.role === "assistant") {
            local.sources = parseSourceTitles(server.citations);
          }
        } else {
          // Nessun append locale: è una novità (risposta di un turno CODE o un
          // messaggio system). Un assistant nuovo chiude l'attesa del turno.
          if (server.role === "assistant") dropPlaceholder = true;
          toAppend.push(fromServerMessage(server));
        }
      }

      if (!changed) return prev;
      const base = dropPlaceholder ? next.filter((message) => !message.placeholder) : next;
      return [...base, ...toAppend];
    });
  }, [serverMessages]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // Soglia generosa (~48px): "quasi in fondo" conta come agganciato, così il
    // follow non si stacca per una riga di differenza dovuta al rendering.
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  // Autoscroll in fondo a ogni nuovo frammento/messaggio — solo se agganciati.
  useEffect(() => {
    if (!pinnedRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  /** Invio in modalità DOCS: stream SSE RAG (comportamento invariato). */
  async function sendDocs(question: string) {
    const userMessage: ChatMessage = { id: nextLocalId(), role: "user", content: question };
    const assistantId = nextLocalId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      streaming: true,
    };
    setMessages((prev) => [...prev, userMessage, assistantMessage]);

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

  /**
   * Invio in modalità CODE: POST non-SSE. Aggiungiamo subito il messaggio utente
   * ottimistico + una bolla placeholder "sta investigando…" (niente streaming).
   * Al 202 registriamo `userMessageId` così il merge non duplica la copia
   * persistita del messaggio utente; la risposta arriva via polling del dettaglio.
   */
  async function sendCode(question: string) {
    const userMessage: ChatMessage = { id: nextLocalId(), role: "user", content: question };
    const placeholder: ChatMessage = {
      id: nextLocalId(),
      role: "assistant",
      content: "",
      placeholder: true,
    };
    setMessages((prev) => [...prev, userMessage, placeholder]);

    try {
      const { userMessageId } = await postBacklogChatTurn(itemId, question);
      // Dedup deterministico: la copia server del messaggio utente non va ri-appesa.
      reconciledServerIds.current.add(userMessageId);
      setMessages((prev) =>
        prev.map((m) => (m.id === userMessage.id ? { ...m, serverId: userMessageId } : m)),
      );
    } catch (error) {
      // Accodamento del turno fallito: togli il placeholder e segnala l'errore.
      const message =
        error instanceof ApiError && error.code === "chat_unavailable" ? "unavailable" : "errored";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === placeholder.id
            ? {
                ...m,
                placeholder: false,
                ...(message === "unavailable" ? { unavailable: true } : { errored: true }),
              }
            : m,
        ),
      );
    } finally {
      setSending(false);
      onExchangeComplete();
    }
  }

  async function send() {
    const question = input.trim();
    // Guardia: in modalità CODE un turno in volo blocca un secondo invio (il
    // placeholder resta finché la risposta non arriva).
    if (!question || sending || turnInFlight) return;
    setInput("");
    setSending(true);
    // Un invio esplicito ri-aggancia al fondo: l'utente vuole vedere la risposta.
    pinnedRef.current = true;
    if (inCodeMode) {
      await sendCode(question);
    } else {
      await sendDocs(question);
    }
  }

  function handleStart() {
    if (repos.length === 0) return;
    if (repos.length === 1) {
      onStartSession(repos[0]!.id);
    } else {
      setRepoDialogOpen(true);
    }
  }

  const repoName = codeSession
    ? (repos.find((repo) => repo.id === codeSession.repositoryId)?.name ?? null)
    : null;
  const modeBadge = inCodeMode
    ? repoName
      ? t("backlog:chat.modeCode", { repo: repoName })
      : t("backlog:chat.modeCodeGeneric")
    : t("backlog:chat.modeDocs");

  // Placeholder sintetico quando il server segnala `pendingTurn` ma non c'è una
  // bolla placeholder locale (es. pagina ricaricata a turno in volo).
  const displayMessages =
    inCodeMode && pendingTurn && !hasPlaceholder
      ? [
          ...messages,
          { id: "pending-turn", role: "assistant", content: "", placeholder: true } as ChatMessage,
        ]
      : messages;

  const sendDisabled = sending || turnInFlight || input.trim().length === 0;

  const body = (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-[11px] tracking-[0.12em] text-fg uppercase">
              {t("backlog:chat.title")}
            </h2>
            <span
              className={`rounded-sm border px-1.5 py-px font-mono text-[10px] tracking-[0.1em] uppercase ${
                inCodeMode ? "border-signal-dim/60 text-signal" : "border-line text-fg-faint"
              }`}
              aria-label={t("backlog:chat.modeLabel")}
              title={modeBadge}
            >
              {modeBadge}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-fg-faint">{t("backlog:chat.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {inCodeMode ? (
            <button
              type="button"
              onClick={onStopSession}
              disabled={sessionPending}
              className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.06em] text-fg-muted uppercase transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {sessionPending ? t("backlog:chat.stopping") : t("backlog:chat.stopSession")}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStart}
              disabled={sessionPending || repos.length === 0}
              title={repos.length === 0 ? t("backlog:chat.noRepos") : undefined}
              className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.06em] text-fg-muted uppercase transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {sessionPending ? t("backlog:chat.starting") : t("backlog:chat.startSession")}
            </button>
          )}
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
        </div>
      </header>

      {sessionError && (
        <p role="alert" className="border-b border-line px-4 py-2 font-mono text-[11px] text-danger">
          {sessionError}
        </p>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {displayMessages.length === 0 ? (
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
            {displayMessages.map((message) => (
              <ChatBubble key={message.id} message={message} />
            ))}
          </ul>
        )}
      </div>

      <form
        // `relative`: la label `sr-only` qui dentro è position:absolute — senza
        // un antenato posizionato si ancorerebbe al documento (fuori dallo
        // scroller del main), allungando la pagina di tutta la sua posizione
        // statica (bug: scroll oltre il contenuto sul dettaglio backlog).
        className="relative border-t border-line p-3"
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
            disabled={sendDisabled}
            className="shrink-0 rounded-sm border border-line-strong px-3 py-2 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
          >
            {turnInFlight
              ? t("backlog:chat.investigatingShort")
              : sending
                ? t("backlog:chat.thinking")
                : t("backlog:chat.send")}
          </button>
        </div>
      </form>

      {repoDialogOpen && (
        <RepoChoiceDialog
          repos={repos}
          pending={sessionPending}
          onPick={(repositoryId) => {
            setRepoDialogOpen(false);
            onStartSession(repositoryId);
          }}
          onClose={() => setRepoDialogOpen(false)}
        />
      )}
    </div>
  );

  // Desktop (`lg+`): pannello inline a piena altezza del contenitore (la cella
  // destra dello split del dettaglio backlog), col corpo scrollabile. L'altezza
  // la governa il chiamante via il track della grid; qui riempiamo con `h-full`
  // (+ `min-h-0` così il corpo interno può scrollare invece di sfondare).
  if (isDesktop) {
    return (
      <section
        aria-label={t("backlog:chat.title")}
        className="flex h-full min-h-0 flex-col overflow-hidden rounded-sm border border-line bg-ink-900"
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
        aria-expanded={open}
        aria-controls="backlog-chat-drawer"
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

/**
 * Una bolla: utente (testo), assistant (markdown + fonti), placeholder di
 * analisi ("sta investigando…") o nota di sistema.
 * `memo`: durante lo streaming ogni delta ri-renderizza la lista, e senza memo
 * il `<Markdown>` di TUTTA la storia persistita verrebbe ri-parsato a ogni
 * frammento — memoizzare la bolla (i messaggi storici sono immutabili) basta.
 */
const ChatBubble = memo(function ChatBubble({ message }: { message: ChatMessage }) {
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
          ) : message.placeholder ? (
            <p
              className="font-mono text-[11px] tracking-[0.08em] text-fg-faint uppercase"
              aria-live="polite"
            >
              {t("backlog:chat.investigating")}
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
});

/**
 * Piccola dialog di scelta del repository per avviare la sessione di analisi
 * (progetto multi-repo). Riusa il pattern della dialog deep-dive: overlay,
 * Escape/click-fuori per chiudere, select + conferma. Self-contained qui perché
 * il guscio modale del dettaglio non è esportato.
 */
function RepoChoiceDialog({
  repos,
  pending,
  onPick,
  onClose,
}: {
  repos: { id: string; name: string }[];
  pending: boolean;
  onPick: (repositoryId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [repositoryId, setRepositoryId] = useState(repos[0]?.id ?? "");
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink-950/80 p-3 backdrop-blur-[2px] sm:p-6"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-session-repo-title"
        className="w-full max-w-md border border-line bg-ink-900 p-5 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
      >
        <h2 id="code-session-repo-title" className="text-lg font-semibold">
          {t("backlog:chat.chooseRepo")}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">{t("backlog:chat.chooseRepoHint")}</p>
        <div className="mt-4 flex flex-col gap-1">
          <label
            htmlFor="code-session-repo"
            className="font-mono text-[10px] font-medium tracking-[0.12em] text-fg-faint uppercase"
          >
            {t("backlog:chat.chooseRepo")}
          </label>
          <select
            id="code-session-repo"
            value={repositoryId}
            onChange={(event) => setRepositoryId(event.target.value)}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[12px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          >
            {repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-4 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
          >
            {t("backlog:chat.cancel")}
          </button>
          <button
            type="button"
            disabled={pending || repositoryId === ""}
            onClick={() => onPick(repositoryId)}
            className="rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
          >
            {t("backlog:chat.startAnalysis")}
          </button>
        </div>
      </div>
    </div>
  );
}
