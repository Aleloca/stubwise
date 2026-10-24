import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  useCitations,
  useConversation,
  useConversationStream,
  usePeople,
  useProjects,
  useSendMessage,
  useSessionPersonId,
  useStopAndSend,
  useStopConversation,
} from "../../../data/queries";
import type { Attachment, ConversationDetail, ConversationEvent } from "../../../data/types";
import { PageError } from "../../../tasks-ui/PageStates";
import { CitationProvider, indexCitations } from "./citations";
import { Composer, type DraftAttachment } from "./Composer";
import { EventList, UserMessage, type DeliveryView } from "./EventList";
import { citedRefs, flowItems, type Ev } from "./flow";
import { ArrowDownGlyph, WorkingRing } from "./parts";

/** Quante righe del flusso si disegnano all'apertura (e quante ne aggiunge «Load earlier»). */
export const FLOW_PAGE = 120;
/** Allegati: quanti al massimo e quanto pesa ciascuno al più. */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Quanto resta «Delivered» sotto un messaggio appena consegnato (ms). */
export const DELIVERED_FADE_MS = 3000;
/** Sotto questa larghezza il componente è un pannello (360–640 px). */
const PANEL_WIDTH = 640;
/** Il lato dell'oggetto agganciato a destra, e da che larghezza del componente ci sta. */
const SIDE_WIDTH = 360;
const SIDE_MIN_WIDTH = 900;
/** Entro quanti px dal fondo si considera «in fondo». */
const BOTTOM_SLACK = 48;

/**
 * La conversazione con Claude, un solo componente per la libera, le sessioni
 * di lavoro, il refine e le sessioni automatiche. Legge il dettaglio (con i
 * permessi di chi guarda) e lo stream dal vivo; `side` è il lato
 * dell'oggetto che passa il chiamante (task, richiesta), agganciato a destra.
 *
 * Tutto ciò che è disegnato è della persona che guarda: cambiando «vedi
 * come» il componente rinasce da zero (chiave per persona), senza una riga
 * della persona di prima — né del flusso né della bozza.
 */
export function Conversation({ id, side }: { id: string; side?: ReactNode }) {
  const me = useSessionPersonId();
  return <ConversationView key={`${me}\u0000${id}`} id={id} side={side} viewerId={me} />;
}

interface LocalMessage {
  /** In ordine d'invio. */
  seq: number;
  text: string;
  attachments: Attachment[];
  /** Quanti messaggi miei con lo stesso testo c'erano già nel flusso quando l'ho mandato. */
  sameBefore: number;
}

function ConversationView({
  id,
  side,
  viewerId,
}: {
  id: string;
  side?: ReactNode;
  viewerId: string;
}) {
  const { t } = useTranslation();
  const detailQuery = useConversation(id);
  const stream = useConversationStream(id);
  const detail = detailQuery.data;

  if (detailQuery.isError) {
    return (
      <PageError
        message={t("claude.conversation.states.error")}
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }
  if (detailQuery.isPending) return <ConversationSkeleton />;
  if (!detail || stream.error === "not_found") {
    return (
      <div className="flex max-w-[60ch] flex-col gap-2 px-8 py-10" role="status">
        <p className="text-md text-ink">{t("claude.conversation.states.notFound")}</p>
      </div>
    );
  }
  return <ConversationBody detail={detail} stream={stream} side={side} viewerId={viewerId} />;
}

function ConversationSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      aria-busy="true"
      className="skeleton-breathe mx-auto flex w-full max-w-[784px] flex-col gap-4 px-8 py-8"
    >
      <span role="status" className="sr-only">
        {t("claude.conversation.states.loading")}
      </span>
      <span className="h-3 w-40 rounded-sm bg-ink/8" />
      <span className="h-9 w-3/4 rounded-md bg-ink/6" />
      <span className="h-3 w-24 rounded-sm bg-ink/8" />
      <span className="h-3 w-full rounded-sm bg-ink/8" />
      <span className="h-3 w-5/6 rounded-sm bg-ink/8" />
    </div>
  );
}

function ConversationBody({
  detail,
  stream,
  side,
  viewerId,
}: {
  detail: ConversationDetail;
  stream: ReturnType<typeof useConversationStream>;
  side?: ReactNode;
  viewerId: string;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [compact, setCompact] = useState(false);
  const [limit, setLimit] = useState(FLOW_PAGE);
  const [newBelow, setNewBelow] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalMessage[]>([]);
  const [failedSend, setFailedSend] = useState<string | null>(null);
  const send = useSendMessage();
  const stop = useStopConversation();
  const stopAndSend = useStopAndSend();
  const projects = useProjects().data;

  // Lo stream porta il flusso dal vivo (e lo ripete all'iscrizione); finché
  // non ha dato nulla vale quello letto col dettaglio.
  const events: ConversationEvent[] = stream.events.length > 0 ? stream.events : detail.events;
  const items = useMemo(() => flowItems(events), [events]);
  const refs = useMemo(() => citedRefs(events), [events]);
  const citations = useCitations(refs);
  const index = useMemo(() => indexCitations(citations.data), [citations.data]);
  const hidden = Math.max(0, items.length - limit);
  const shown = hidden > 0 ? items.slice(hidden) : items;

  const projectCode =
    projects?.find((p) => p.id === (detail.projectId ?? detail.contextProjectId))?.code ?? null;

  // --- pannello stretto: niente colonna avatar, gruppi sempre chiusi; il
  // lato si aggancia a destra solo se resta posto per leggere, altrimenti
  // sta in testa al flusso ---
  const [sideDocked, setSideDocked] = useState(true);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = entry.contentRect.width;
      const docked = width >= SIDE_MIN_WIDTH;
      setSideDocked(docked);
      setCompact(width - (side && docked ? SIDE_WIDTH : 0) < PANEL_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [side]);

  // --- consegna: «Delivered» resta 3 s solo per ciò che ho visto partire ---
  const seenPending = useRef(new Set<string>());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const justDelivered: string[] = [];
    for (const e of events) {
      if (e.type !== "user" || e.authorId !== viewerId) continue;
      if (e.delivery === "pending") seenPending.current.add(e.id);
      else if (e.delivery === "delivered" && seenPending.current.delete(e.id)) {
        justDelivered.push(e.id);
      }
    }
    if (justDelivered.length === 0) return;
    setFresh((s) => new Set([...s, ...justDelivered]));
    const timer = setTimeout(
      () => setFresh((s) => new Set([...s].filter((x) => !justDelivered.includes(x)))),
      DELIVERED_FADE_MS,
    );
    return () => clearTimeout(timer);
  }, [events, viewerId]);
  const deliveryOf = useCallback(
    (e: Ev<"user">): DeliveryView => {
      if (e.delivery === "pending") return { kind: "pending" };
      if (e.delivery === "undelivered") {
        return { kind: "undelivered", reason: e.undeliveredReason ?? null };
      }
      return fresh.has(e.id) ? { kind: "delivered" } : null;
    },
    [fresh],
  );

  // --- messaggi in coda: non sono nel flusso finché non arriva il loro turno ---
  const mine = (text: string) =>
    events.filter((e) => e.type === "user" && e.authorId === viewerId && e.text === text).length;
  const queued = local.filter((m) => {
    // Nascosto appena il flusso ha il messaggio (uno in più di quanti ce n'erano).
    const ahead = local.filter((o) => o.text === m.text && o.seq < m.seq).length;
    return mine(m.text) <= m.sameBefore + ahead;
  });
  const nextSeq = useRef(0);

  const sendMessage = (text: string, attachments: Attachment[]) => {
    setFailedSend(null);
    const seq = (nextSeq.current += 1);
    const entry: LocalMessage = { seq, text, attachments, sameBefore: mine(text) };
    setLocal((list) => [...list, entry]);
    setDrafts([]);
    setAttachError(null);
    atBottom.current = true;
    send.mutate(
      { id: detail.id, text, ...(attachments.length ? { attachments } : {}) },
      {
        onSettled: () => setLocal((list) => list.filter((m) => m.seq !== seq)),
        onError: () => setFailedSend(text),
      },
    );
  };

  // --- allegati: graffetta, incolla, trascina; 10 file da 20 MB ---
  const addFiles = useCallback(
    (files: File[]) => {
      if (!detail.canWrite || files.length === 0) return;
      setAttachError(null);
      setDrafts((current) => {
        const next = [...current];
        let error: string | null = null;
        for (const file of files) {
          if (next.length >= MAX_ATTACHMENTS) {
            error = t("claude.conversation.attachments.tooMany", { count: MAX_ATTACHMENTS });
            break;
          }
          if (file.size > MAX_ATTACHMENT_BYTES) {
            error = t("claude.conversation.attachments.tooBig", { name: file.name, mb: 20 });
            continue;
          }
          const image = file.type.startsWith("image/");
          next.push({
            attachment: {
              id: `att-${Date.now().toString(36)}-${next.length}-${Math.random().toString(36).slice(2, 6)}`,
              name: file.name || t("claude.conversation.attachments.pasted"),
              sizeBytes: file.size,
              kind: image ? "image" : "file",
            },
            ...(image && typeof URL.createObjectURL === "function"
              ? { previewUrl: URL.createObjectURL(file) }
              : {}),
          });
        }
        setAttachError(error);
        return next;
      });
    },
    [detail.canWrite, t],
  );
  const removeDraft = (attachmentId: string) =>
    setDrafts((list) => {
      const gone = list.find((d) => d.attachment.id === attachmentId);
      if (gone?.previewUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(gone.previewUrl);
      }
      return list.filter((d) => d.attachment.id !== attachmentId);
    });

  const onDrag = (e: DragEvent<HTMLDivElement>, over: boolean) => {
    if (!detail.canWrite || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    setDragging(over);
  };

  // --- scorrimento: segue il fondo solo se sei in fondo ---
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (atBottom.current) setNewBelow(false);
  };
  const count = items.length + queued.length;
  const lastSize = useRef<{ count: number; text: number }>({ count: 0, text: 0 });
  const tailText =
    events.at(-1)?.type === "assistant" ? (events.at(-1) as Ev<"assistant">).text.length : 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const grew = count > lastSize.current.count || tailText > lastSize.current.text;
    lastSize.current = { count, text: tailText };
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else if (grew) setNewBelow(true);
  }, [count, tailText]);
  // Il flusso cresce anche senza eventi nuovi (le citazioni lette dopo, una
  // scheda che si apre, un'immagine): chi è in fondo ci resta.
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
    atBottom.current = true;
    setNewBelow(false);
  };
  const loadEarlier = () => {
    const el = scroller.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    setLimit((n) => n + FLOW_PAGE);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  };

  // --- annunci: un messaggio di Claude finito (cortese), una scheda per me (subito) ---
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const announced = useRef<{ done: Set<string>; cards: Set<string>; ready: boolean }>({
    done: new Set(),
    cards: new Set(),
    ready: false,
  });
  useEffect(() => {
    const seen = announced.current;
    for (const e of events) {
      if (e.type === "assistant" && e.done && !seen.done.has(e.id)) {
        seen.done.add(e.id);
        if (seen.ready) setPolite(e.text.slice(0, 280));
      }
      const forMe =
        (e.type === "question" && e.answer === null && detail.canAnswer) ||
        (e.type === "plan" && e.status === "pending" && detail.canDecidePlan) ||
        (e.type === "proposal" && e.status === "open" && e.requesterId === viewerId);
      if (forMe && !seen.cards.has(e.id)) {
        seen.cards.add(e.id);
        if (seen.ready) setAssertive(t("claude.conversation.announce.decision"));
      }
    }
    seen.ready = true;
  }, [events, detail.canAnswer, detail.canDecidePlan, viewerId, t]);

  const working = detail.state === "working";
  const readOnly = !detail.canWrite;

  return (
    <CitationProvider value={index}>
      <div
        ref={root}
        data-conversation={detail.id}
        data-compact={compact || undefined}
        className="relative flex h-full min-h-0 w-full min-w-0 overflow-hidden"
        onDragEnter={(e) => onDrag(e, true)}
        onDragOver={(e) => onDrag(e, true)}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          if (!detail.canWrite) return;
          e.preventDefault();
          setDragging(false);
          addFiles([...(e.dataTransfer?.files ?? [])]);
        }}
      >
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={scroller}
            onScroll={onScroll}
            data-conversation-scroll
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
          >
            {side && !sideDocked && (
              <div className="max-h-[40%] overflow-y-auto border-b border-rule">{side}</div>
            )}
            <div
              ref={content}
              className={`mx-auto flex w-full min-w-0 flex-col gap-3 ${compact ? "max-w-[752px] px-4 py-4" : "max-w-[784px] px-8 py-6"}`}
            >
              {stream.connection === "reconnecting" && (
                <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
                  <WorkingRing />
                  {t("claude.conversation.states.reconnecting")}
                </p>
              )}
              {detail.privateTail && (
                <p className="text-sm text-ink-muted">
                  {t("claude.conversation.states.privateTail")}
                </p>
              )}
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={loadEarlier}
                  className="self-center rounded-md px-3 py-1 text-sm font-medium text-ink-muted hover:bg-ink/6 hover:text-ink"
                >
                  {t("claude.conversation.loadEarlier")}
                </button>
              )}
              <EventList
                items={shown}
                detail={detail}
                viewerId={viewerId}
                compact={compact}
                projectCode={projectCode}
                deliveryOf={deliveryOf}
                onResend={(e) => sendMessage(e.text, e.attachments)}
              />
              {queued.length > 0 && (
                <ol className="flex flex-col gap-2.5" aria-label={t("claude.conversation.queued")}>
                  {queued.map((m) => (
                    <li key={m.seq}>
                      <UserMessage
                        authorId={viewerId}
                        at={null}
                        text={m.text}
                        attachments={m.attachments}
                        delivery={{ kind: "pending" }}
                      />
                    </li>
                  ))}
                </ol>
              )}
              {failedSend !== null && (
                <p role="alert" className="text-sm text-critical">
                  {t("claude.conversation.delivery.sendFailed")}{" "}
                  <button
                    type="button"
                    className="font-semibold text-ink underline decoration-ink/30 underline-offset-2"
                    onClick={() => sendMessage(failedSend, [])}
                  >
                    {t("claude.conversation.delivery.resend")}
                  </button>
                </p>
              )}
              {working && shown.at(-1)?.kind === "user" && (
                <p className="flex items-center gap-2 text-sm text-ink-muted">
                  <WorkingRing />
                  {t("claude.conversation.thinking")}
                </p>
              )}
            </div>
          </div>
          {/* La pillola flotta sopra la casella, al centro della colonna. */}
          <div className="relative h-0">
            {newBelow && (
              <button
                type="button"
                onClick={toBottom}
                className="toast-enter absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-rule-strong bg-surface px-3 text-sm font-medium whitespace-nowrap text-ink shadow-[0_4px_16px_-4px_oklch(0_0_0/0.35)] hover:bg-ink/4"
              >
                {t("claude.conversation.newMessages")}
                <ArrowDownGlyph />
              </button>
            )}
          </div>
          {readOnly ? (
            <ReadOnlyBand detail={detail} compact={compact} projectCode={projectCode} />
          ) : (
            <Composer
              detail={detail}
              connection={stream.connection}
              compact={compact}
              attachments={drafts}
              attachError={attachError}
              onAddFiles={addFiles}
              onRemoveAttachment={removeDraft}
              onSend={sendMessage}
              onStop={() => stop.mutate(detail.id)}
              onStopAndSend={(text) => stopAndSend.mutate({ id: detail.id, text })}
            />
          )}
          {dragging && (
            <div
              aria-hidden="true"
              className="event-enter pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-dashed border-ink/50 bg-ground/85 text-md font-semibold text-ink"
            >
              {t("claude.conversation.attachments.drop")}
            </div>
          )}
        </div>
        {side && sideDocked && (
          <aside className="h-full w-[360px] shrink-0 overflow-y-auto border-l border-rule">
            {side}
          </aside>
        )}
        <div className="sr-only" aria-live="polite">
          {polite}
        </div>
        <div className="sr-only" aria-live="assertive">
          {assertive}
        </div>
      </div>
    </CitationProvider>
  );
}

/** Al posto della casella, quando chi guarda non può scrivere: il motivo del «server». */
function ReadOnlyBand({
  detail,
  compact,
  projectCode,
}: {
  detail: ConversationDetail;
  compact: boolean;
  projectCode: string | null;
}) {
  const { t } = useTranslation();
  const owner = usePeople().data?.find((p) => p.id === detail.ownerId)?.name ?? "";
  const reason = detail.readOnlyReason;
  let text: string;
  switch (reason) {
    case "not_owner":
      text = t("claude.conversation.readOnly.notOwner", { name: owner });
      break;
    case "archived":
      text = t("claude.conversation.readOnly.archived");
      break;
    case "automatic":
      text = t("claude.conversation.readOnly.automatic");
      break;
    case "finished":
      text = t(`claude.conversation.readOnly.finished.${detail.outcome ?? "ok"}`);
      break;
    case "no_permission":
      text =
        detail.kind === "refine"
          ? t("claude.conversation.readOnly.refine", { code: projectCode ?? "" })
          : t("claude.conversation.readOnly.maintainer");
      break;
    default:
      text = t("claude.conversation.readOnly.watchOnly");
  }
  return (
    <div className={compact ? "px-4 pt-2 pb-3" : "px-8 pt-2 pb-5"}>
      <p
        data-read-only={reason ?? "not_interactive"}
        className="mx-auto w-full max-w-[720px] rounded-lg bg-ink/5 px-4 py-3 text-sm text-ink-muted"
      >
        {text}
      </p>
    </div>
  );
}
