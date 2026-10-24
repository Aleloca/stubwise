import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  useChatChannel,
  useChatThread,
  useCitations,
  useCodeCitations,
  useDeleteChatMessage,
  useDepartments,
  useEditChatMessage,
  useJoinChannel,
  useMarkThreadRead,
  usePeople,
  useSendChatMessage,
  useSessionPersonId,
  useSetThreadFollow,
  useThreadStream,
  useToggleReaction,
} from "../../data/queries";
import type {
  ChannelView as ChannelData,
  ChatMessageView,
  CitationRef,
  ThreadView,
} from "../../data/types";
import {
  DOCKED_PANEL_QUERY,
  DetailPanel,
  forcesOverlay,
  type DetailPanelMode,
} from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { copyText } from "../../tasks-ui/exportFile";
import { itemClass, MenuGroup } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { CitationProvider, indexCitations } from "../claude/conversation/citations";
import type { DraftAttachment } from "../claude/conversation/Composer";
import { CODE_IN_TEXT } from "../claude/conversation/flow";
import { ArrowDownGlyph, primaryButton } from "../claude/conversation/parts";
import { NewRequestDialog } from "../requests/NewRequestDialog";
import { NewTaskDialog } from "../task/NewTaskDialog";
import { CloseIcon, ghostButton } from "../task/parts";
import { MenuButton } from "../tasks/controls";
import { chatHref, useChannelName } from "./ChannelView";
import { ChatComposer, type ChatSendInput } from "./ChatComposer";
import { ClaudeReply } from "./ClaudeReply";
import { onReplyFocus, takeReplyFocus } from "./drafts";
import { mostUsed } from "./emoji";
import { mergeThread, threadRows } from "./flow";
import { ChatAvatar, MessageItem } from "./MessageItem";

// Il pannello del thread (`?thread=<radice>`): lo stesso posto del dettaglio
// della task — 400px agganciato da 1200px, sovrapposto con il velo sotto —
// con il flusso della chat dentro: la radice in testa, un filetto «4
// replies», le risposte (stessi gruppi del canale, avatar 24px), la casella
// con «Also send to …» in fondo. Le risposte di @Claude arrivano dal vivo
// sulla coda del thread. Si apre da qualunque pagina (canale, Threads,
// Mentions, ricerca, notifiche, «Da decidere»); un thread che non c'è o non
// si legge non si apre (toast). Cambiare persona lo chiude e ne perde la
// bozza: niente di chi guardava prima resta a schermo.

const CODE_RE = new RegExp(CODE_IN_TEXT.source, "g");
/** Quanto vicino al fondo conta come «in fondo» (px). */
const BOTTOM_SLACK = 48;
/** La larghezza di partenza del pannello (shape: le schede a 360 vanno a capo troppo). */
const THREAD_WIDTH = 400;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Un istante subito prima di `iso` («Mark unread»). */
const justBefore = (iso: string) =>
  new Date(Date.parse(iso) - 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Montato dal layout accanto al dettaglio della task: si apre su `?thread=`.
 * Chiuderlo (×, Esc, il velo) toglie `thread` dall'indirizzo e ridà il fuoco
 * al messaggio radice, se è a schermo.
 */
export function ThreadPanelHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { thread?: string };
  const personId = useSessionPersonId();
  const wide = useMediaQuery(DOCKED_PANEL_QUERY);
  const overlayOnly = useRouterState({ select: (s) => forcesOverlay(s.location.pathname) });
  const mode: DetailPanelMode = wide && !overlayOnly ? "docked" : "overlay";
  const thread = search.thread;

  const close = useCallback(
    (focusRoot = true) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, thread: undefined }),
      } as never);
      if (focusRoot && thread) {
        requestAnimationFrame(() => {
          const row = document.querySelector<HTMLElement>(
            `[data-zone="work"] [data-message="${CSS.escape(thread)}"]`,
          );
          const line = row?.querySelector<HTMLElement>("[data-thread-summary]");
          if (line) return line.focus();
          // Senza la riga del thread (nessuna risposta): il messaggio stesso.
          if (row && !row.hasAttribute("tabindex")) row.setAttribute("tabindex", "-1");
          row?.focus();
        });
      }
    },
    [navigate, thread],
  );

  // Cambio di persona: il pannello si chiude (e la bozza si perde con lui).
  const [viewer, setViewer] = useState(personId);
  const [suppressed, setSuppressed] = useState<string | null>(null);
  if (viewer !== personId) {
    setViewer(personId);
    if (thread) setSuppressed(thread);
  }
  useEffect(() => {
    if (suppressed && thread === suppressed) close(false);
    if (!thread && suppressed) setSuppressed(null);
  }, [suppressed, thread, close]);

  if (!thread || thread === suppressed) return null;
  return (
    <>
      {mode === "overlay" && (
        <div
          aria-hidden="true"
          data-thread-scrim
          className="palette-backdrop fixed inset-0 z-30 bg-[var(--scrim)]"
          onClick={() => close()}
        />
      )}
      <DetailPanel
        mode={mode}
        label={t("chat.thread.title")}
        onClose={close}
        defaultWidth={THREAD_WIDTH}
        modal
      >
        <TrapFocus active={mode === "overlay"}>
          <ThreadPanel key={`${personId}:${thread}`} messageId={thread} onClose={close} />
        </TrapFocus>
      </DetailPanel>
    </>
  );
}

/** Sovrapposto, Tab e Maiusc+Tab restano nel pannello. */
function TrapFocus({ active, children }: { active: boolean; children: ReactNode }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!active || e.key !== "Tab") return;
    const panel = e.currentTarget.closest<HTMLElement>("[data-detail-panel]");
    if (!panel) return;
    const focusables = [
      ...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null || el === document.activeElement);
    const first = focusables[0];
    const last = focusables.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

function ThreadPanel({
  messageId,
  onClose,
}: {
  messageId: string;
  onClose: (focusRoot?: boolean) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const query = useChatThread(messageId);
  const channel = useChatChannel(query.data?.channelId ?? "");
  const missing = query.isSuccess && query.data === null;
  // Un thread che non c'è o non si legge non si apre: toast e via dall'indirizzo.
  useEffect(() => {
    if (!missing) return;
    toast.error(t("chat.thread.notFound"));
    onClose(false);
  }, [missing, toast, t, onClose]);

  if (query.isError) {
    return (
      <>
        <PanelTop onClose={() => onClose()} />
        <div className="px-4">
          <PageError message={t("chat.thread.error")} onRetry={() => void query.refetch()} />
        </div>
      </>
    );
  }
  if (missing) return null;
  if (!query.data || !channel.data) return <ThreadSkeleton onClose={() => onClose()} />;
  return <ThreadBody thread={query.data} channel={channel.data} onClose={() => onClose()} />;
}

/** La testata: «Thread» + «in AUD · general» (link al canale), «⋯» e ×. */
function PanelTop({
  onClose,
  channelLabel,
  channelHref,
  menu,
}: {
  onClose: () => void;
  channelLabel?: string;
  channelHref?: string;
  menu?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <header className="page-header box-content flex h-12 shrink-0 items-center gap-2 border-b border-rule pl-4 [--page-header-pr:8px]">
      <h2 className="shrink-0 text-lg font-semibold text-ink">{t("chat.thread.title")}</h2>
      {channelLabel && channelHref && (
        <a
          href={channelHref}
          className="min-w-0 truncate text-sm text-ink-muted hover:text-ink hover:underline"
          title={channelLabel}
        >
          {t("chat.thread.in", { name: channelLabel })}
        </a>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {menu}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("chat.thread.close")}
          title={t("chat.thread.close")}
          className={`${ghostButton} w-8 justify-center px-0`}
        >
          <CloseIcon />
        </button>
      </span>
    </header>
  );
}

function ThreadSkeleton({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <PanelTop onClose={onClose} />
      <div aria-busy="true" className="skeleton-breathe flex flex-col gap-5 px-4 pt-4">
        <span role="status" className="sr-only">
          {t("chat.thread.loading")}
        </span>
        {Array.from({ length: 4 }, (_, i) => (
          <span key={i} className="flex gap-2.5">
            <span className="size-6 shrink-0 rounded-full bg-ink/8" />
            <span className="flex flex-1 flex-col gap-2">
              <span className="h-3 w-32 rounded bg-ink/8" />
              <span
                className="h-3 rounded bg-ink/6"
                style={{ width: `${50 + ((i * 19) % 40)}%` }}
              />
            </span>
          </span>
        ))}
      </div>
    </>
  );
}

interface LocalSend {
  key: number;
  input: ChatSendInput;
  state: "sending" | "failed";
}

function ThreadBody({
  thread,
  channel,
  onClose,
}: {
  thread: ThreadView;
  channel: ChannelData;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const toast = useToast();
  const people = usePeople().data;
  const departments = useDepartments().data;
  const name = useChannelName(channel, me);
  const stream = useThreadStream(thread.root.id);
  const { root, replies } = useMemo(
    () => mergeThread(thread.root, thread.replies, stream.messages),
    [thread, stream.messages],
  );
  // La riga «New replies»: fin dove si era letto aprendo; resta finché il pannello è aperto.
  const [readAt] = useState(thread.lastReadAt);
  const rows = useMemo(
    () => threadRows(replies, { viewerId: me, lastReadAt: readAt }),
    [replies, me, readAt],
  );
  const send = useSendChatMessage();
  const edit = useEditChatMessage();
  const remove = useDeleteChatMessage();
  const react = useToggleReaction();
  const markRead = useMarkThreadRead();
  const follow = useSetThreadFollow();
  const join = useJoinChannel();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{
    kind: "task" | "request";
    message: ChatMessageView;
  } | null>(null);
  const [local, setLocal] = useState<LocalSend[]>([]);
  const nextKey = useRef(0);
  const all = useMemo(() => [root, ...replies], [root, replies]);

  // «Reply in thread» (shape §6): il fuoco nella casella, aprendo o a pannello già aperto.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focus = () =>
      body.current?.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea")?.focus();
    if (takeReplyFocus(root.id)) focus();
    return onReplyFocus((rootId) => {
      if (rootId === root.id && takeReplyFocus(rootId)) requestAnimationFrame(focus);
    });
  }, [root.id]);

  // Le citazioni del thread, lette una volta per chi guarda (R-E9); anche i
  // codici delle righe e delle schede di Claude.
  const refs = useMemo(() => {
    const out: CitationRef[] = [];
    const seen = new Set<string>();
    for (const m of all) {
      for (const ref of [...m.citations, ...m.linkedRefs]) {
        const k = `${ref.kind}:${ref.id}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push(ref);
        }
      }
    }
    return out;
  }, [all]);
  const citations = useCitations(refs);
  const codes = useMemo(() => {
    const found = new Set<string>();
    const scan = (text: string | undefined) => {
      for (const c of text?.match(CODE_RE) ?? []) found.add(c);
    };
    for (const m of all) {
      scan(m.text);
      for (const e of m.claudeEvents ?? []) {
        if (e.type === "action") scan(e.label);
        if (e.type === "proposal") e.actions.forEach((a) => scan(a.summary));
        if (e.type === "question") scan(e.text);
      }
    }
    return [...found].sort();
  }, [all]);
  const codeViews = useCodeCitations(codes);
  const index = useMemo(
    () => indexCitations([...(codeViews.data ?? []), ...(citations.data ?? [])]),
    [citations.data, codeViews.data],
  );
  const mentionNames = useMemo(
    () => [
      ...(people ?? []).map((p) => p.name),
      ...(departments ?? []).map((d) => d.name),
      "channel",
      "Claude",
    ],
    [people, departments],
  );
  const frequent = useMemo(
    () =>
      mostUsed(
        all.flatMap((m) => m.reactions),
        me,
      ),
    [all, me],
  );

  // --- letto: quando il fondo è in vista (solo un thread che si segue) ---
  const latest = replies.at(-1)?.createdAt ?? root.createdAt;
  const markedUpTo = useRef<string | null>(readAt);
  const following = root.thread?.following ?? thread.lastReadAt !== null;
  const onAtBottom = useCallback(() => {
    if (!following) return;
    if (markedUpTo.current !== null && markedUpTo.current >= latest) return;
    markedUpTo.current = latest;
    markRead.mutate({ rootId: root.id });
  }, [following, latest, markRead, root.id]);

  // --- annunci: la risposta di Claude finita (polite), una domanda per me (assertive) ---
  const [announce, setAnnounce] = useState("");
  const [alert, setAlert] = useState("");
  const states = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const now = new Map(
      replies.filter((r) => r.kind === "claude").map((r) => [r.id, r.claudeRun?.state ?? "done"]),
    );
    const before = states.current;
    states.current = now;
    if (!before) return;
    for (const [id, state] of now) {
      const was = before.get(id);
      if (was === "working" && state === "done") setAnnounce(t("chat.claude.replied"));
      const reply = replies.find((r) => r.id === id);
      if (was === "working" && state === "waiting" && reply?.calledById === me) {
        setAlert(t("chat.claude.asksYou"));
      }
    }
  }, [replies, me, t]);

  // --- invio: subito in coda, «Not sent · Resend» se non passa ---
  const deliver = (key: number, input: ChatSendInput) => {
    send
      .mutateAsync({
        channelId: channel.id,
        input: {
          text: input.text,
          threadOf: root.id,
          ...(input.attachments.length ? { attachments: input.attachments } : {}),
          ...(input.citations.length ? { citations: input.citations } : {}),
          ...(input.asksReply ? { asksReply: true } : {}),
          ...(input.alsoInChannel ? { alsoInChannel: true } : {}),
        },
      })
      .then(
        () => setLocal((list) => list.filter((l) => l.key !== key)),
        () => setLocal((list) => list.map((l) => (l.key === key ? { ...l, state: "failed" } : l))),
      );
  };
  const onSend = (input: ChatSendInput) => {
    nextKey.current += 1;
    const key = nextKey.current;
    setLocal((list) => [...list, { key, input, state: "sending" }]);
    setDrafts([]);
    setAttachError(null);
    deliver(key, input);
  };

  // --- allegati: come nel canale, 10 file da 20 MB ---
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const addFiles = (files: File[]) => {
    if (!channel.canWrite || files.length === 0) return;
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
        nextKey.current += 1;
        next.push({
          attachment: {
            id: `att-thread-${nextKey.current}`,
            name: file.name || t("claude.conversation.attachments.pasted"),
            sizeBytes: file.size,
            kind: file.type.startsWith("image/") ? "image" : "file",
          },
        });
      }
      setAttachError(error);
      return next;
    });
  };

  const copyLink = (m: ChatMessageView | null) => {
    const base =
      typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "";
    const href = chatHref(channel.id)(m ? { thread: root.id, message: m.id } : { thread: root.id });
    copyText(`${base}${href}`).then(
      () => toast.show(t("chat.actions.linkCopied")),
      () => toast.error(t("chat.actions.copyFailed")),
    );
  };

  const renderMessage = (m: ChatMessageView, head: boolean, isRoot = false) =>
    m.kind === "claude" ? (
      <ClaudeReply
        key={m.id}
        message={m}
        viewerId={me}
        canWrite={channel.canWrite}
        mentionNames={mentionNames}
        onCopyLink={() => copyLink(m)}
      />
    ) : (
      <MessageItem
        key={m.id}
        message={m}
        head={head}
        compact
        viewerId={me}
        canWrite={channel.canWrite}
        member={channel.isMember}
        mentionNames={mentionNames}
        quick={frequent.slice(0, 3)}
        frequent={frequent}
        threadHref={chatHref(channel.id)({ thread: root.id })}
        rootExcerpt={null}
        editing={editingId === m.id}
        onToggleReaction={(emoji) =>
          react.mutate(
            { id: m.id, emoji },
            { onError: () => toast.error(t("chat.reactions.failed")) },
          )
        }
        onSaveEdit={(text) => edit.mutateAsync({ id: m.id, text }).then(() => setEditingId(null))}
        onCancelEdit={() => setEditingId(null)}
        onConfirmDelete={() => remove.mutateAsync(m.id).then(() => undefined)}
        actions={{
          onCopyLink: () => copyLink(isRoot ? null : m),
          onMarkUnread: () => {
            markedUpTo.current = latest;
            markRead.mutate({ rootId: root.id, at: justBefore(m.createdAt) });
          },
          onCreateTask: () => setCreating({ kind: "task", message: m }),
          onCreateRequest: () => setCreating({ kind: "request", message: m }),
          onEdit: () => setEditingId(m.id),
        }}
      />
    );

  const editLast = () => {
    const mine = [...replies]
      .reverse()
      .find((m) => m.kind === "person" && m.authorId === me && m.deletedAt === null);
    if (!mine) return false;
    setEditingId(mine.id);
    return true;
  };

  const me_ = people?.find((p) => p.id === me);
  const tail =
    local.length > 0 ? (
      <ol aria-label={t("chat.message.outbox")} className="flex flex-col">
        {local.map((l) => (
          <li
            key={l.key}
            className="mt-2 flex min-w-0 gap-2.5 px-2 pt-1.5"
            data-local-send={l.state}
            role={l.state === "failed" ? "alert" : undefined}
          >
            <ChatAvatar person={me_} size={24} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-semibold text-ink">{me_?.name ?? ""}</span>
              <p className="min-w-0 text-md whitespace-pre-wrap text-ink-muted [overflow-wrap:anywhere]">
                {l.input.text}
              </p>
              {l.state === "failed" && (
                <p className="text-xs">
                  <span className="font-semibold text-critical">{t("chat.message.notSent")}</span>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => {
                      setLocal((list) =>
                        list.map((x) => (x.key === l.key ? { ...x, state: "sending" } : x)),
                      );
                      deliver(l.key, l.input);
                    }}
                    className="font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
                  >
                    {t("chat.message.resend")}
                  </button>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => setLocal((list) => list.filter((x) => x.key !== l.key))}
                    className="font-semibold text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
                  >
                    {t("chat.actions.delete")}
                  </button>
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    ) : null;

  const menu = (
    <MenuButton
      menuLabel={t("chat.thread.more")}
      ariaLabel={t("chat.thread.more")}
      title={t("chat.thread.more")}
      align="right"
      className="grid size-8 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink"
      label={
        <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" fill="currentColor">
          <circle cx="3.5" cy="8" r="1.2" />
          <circle cx="8" cy="8" r="1.2" />
          <circle cx="12.5" cy="8" r="1.2" />
        </svg>
      }
    >
      {(close) => (
        <MenuGroup>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              close();
              copyLink(null);
            }}
          >
            {t("chat.thread.copyLink")}
          </button>
          {channel.isMember && (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                close();
                follow.mutate(
                  { rootId: root.id, following: !following },
                  { onError: () => toast.error(t("chat.thread.followFailed")) },
                );
              }}
            >
              {following ? t("chat.thread.unfollow") : t("chat.thread.follow")}
            </button>
          )}
          {following && replies.length > 0 && (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                close();
                markedUpTo.current = latest;
                markRead.mutate({ rootId: root.id, at: justBefore(replies.at(-1)!.createdAt) });
              }}
            >
              {t("chat.thread.markUnread")}
            </button>
          )}
        </MenuGroup>
      )}
    </MenuButton>
  );

  return (
    <CitationProvider value={index}>
      <div ref={body} className="@container flex min-h-0 flex-1 flex-col" data-thread={root.id}>
        <PanelTop
          onClose={onClose}
          channelLabel={name.label}
          channelHref={chatHref(channel.id)({})}
          menu={menu}
        />
        <ThreadScroller
          signature={`${replies.length}:${replies.at(-1)?.id}:${replies.at(-1)?.text.length}:${replies.at(-1)?.claudeEvents?.length ?? 0}:${local.length}`}
          lastId={replies.at(-1)?.id ?? root.id}
          onAtBottom={onAtBottom}
          label={t("chat.thread.list")}
        >
          {renderMessage(root, true, true)}
          <p
            className="mx-2 mt-3 mb-1 flex items-center gap-3 text-xs font-semibold text-ink-muted"
            data-thread-count
          >
            <span className="num shrink-0">
              {replies.length > 0
                ? t("chat.thread.replies", { count: replies.length })
                : t("chat.thread.noReplies")}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-rule" />
          </p>
          {rows.map((row, i) =>
            row.kind === "new" ? (
              <p
                key="new"
                data-new-line
                className="my-1 flex items-center gap-3 pl-2 text-xs font-semibold text-ink"
              >
                <span className="shrink-0">{t("chat.thread.newReplies")}</span>
                <span aria-hidden="true" className="h-px flex-1 bg-ink" />
              </p>
            ) : row.kind === "message" ? (
              renderMessage(row.message, row.head)
            ) : (
              <span key={i} />
            ),
          )}
          {tail}
        </ThreadScroller>
        <div className="sr-only" aria-live="polite" data-thread-announce>
          {announce}
        </div>
        <div className="sr-only" aria-live="assertive" data-thread-alert>
          {alert}
        </div>
        {channel.archived ? (
          <p
            role="status"
            data-thread-band
            className="mx-4 mt-1 mb-4 border-t border-rule pt-3 text-sm text-ink-muted"
          >
            {t("chat.channel.archivedBand")}
          </p>
        ) : !channel.isMember ? (
          <p
            role="status"
            data-thread-band
            className="mx-4 mt-1 mb-4 flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3 text-sm text-ink-muted"
          >
            <span>{t("chat.thread.joinToReply")}</span>
            {channel.canJoin && (
              <button
                type="button"
                className={primaryButton}
                disabled={join.isPending}
                onClick={() =>
                  join.mutate(channel.id, {
                    onError: () => toast.error(t("chat.channel.joinFailed")),
                  })
                }
              >
                {t("chat.channel.join")}
              </button>
            )}
          </p>
        ) : (
          <ChatComposer
            channelId={channel.id}
            channelLabel={name.label}
            viewerId={me}
            memberIds={channel.memberIds}
            attachments={drafts}
            attachError={attachError}
            onAddFiles={addFiles}
            onRemoveAttachment={(id) =>
              setDrafts((list) => list.filter((d) => d.attachment.id !== id))
            }
            onSend={onSend}
            onEditLast={editLast}
            draftKey={`thread:${root.id}`}
            placeholder={t("chat.thread.reply")}
            alsoSendTo={name.label}
            compact
          />
        )}
        {creating?.kind === "task" && (
          <NewTaskDialog
            {...(channel.projectId ? { projectId: channel.projectId } : {})}
            fromMessageId={creating.message.id}
            initial={{ title: creating.message.text.split("\n")[0]!.slice(0, 120) }}
            onCreated={(task) => {
              setCreating(null);
              toast.show(t("chat.actions.taskCreated", { code: task.code }));
            }}
            onClose={() => setCreating(null)}
          />
        )}
        {creating?.kind === "request" && (
          <NewRequestDialog
            {...(channel.projectId ? { projectId: channel.projectId } : {})}
            fromMessageId={creating.message.id}
            initial={{ title: creating.message.text.split("\n")[0]!.slice(0, 120) }}
            onCreated={(request) => {
              setCreating(null);
              toast.show(t("chat.actions.requestCreated", { code: request.code }));
            }}
            onClose={() => setCreating(null)}
          />
        )}
      </div>
    </CitationProvider>
  );
}

/**
 * Lo scorrimento del thread: apre in fondo (o sulla riga «New replies»),
 * segue il fondo mentre arriva qualcosa — anche la risposta di Claude che
 * cresce — solo se eri in fondo; altrimenti la pillola «New replies ↓».
 */
function ThreadScroller({
  signature,
  lastId,
  onAtBottom,
  label,
  children,
}: {
  signature: string;
  lastId: string;
  onAtBottom: () => void;
  label: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const placed = useRef(false);
  const seenLast = useRef(lastId);
  const [newBelow, setNewBelow] = useState(false);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!placed.current) {
      placed.current = true;
      const line = el.querySelector<HTMLElement>("[data-new-line]");
      if (line) el.scrollTop = Math.max(0, line.offsetTop - 48);
      else el.scrollTop = el.scrollHeight;
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
      if (atBottom.current) onAtBottom();
      return;
    }
    const arrived = seenLast.current !== lastId;
    seenLast.current = lastId;
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
      onAtBottom();
    } else if (arrived) setNewBelow(true);
    // Solo quando cambia ciò che sta in fondo.
  }, [signature, lastId]);

  // Il contenuto cresce anche senza un messaggio nuovo (una citazione letta
  // dopo, una scheda che compare): in fondo si resta in fondo.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    if (atBottom.current) {
      setNewBelow(false);
      onAtBottom();
    }
  };

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
    atBottom.current = true;
    setNewBelow(false);
    onAtBottom();
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        data-thread-scroll
        role="log"
        aria-live="off"
        aria-label={label}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pt-2 pb-3 [overflow-anchor:none]"
      >
        <div ref={content} className="flex min-w-0 flex-col">
          {children}
        </div>
      </div>
      <div className="relative h-0">
        {newBelow && (
          <button
            type="button"
            onClick={toBottom}
            className="toast-enter absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-rule-strong bg-surface px-3 text-sm font-medium whitespace-nowrap text-ink shadow-[0_4px_16px_-4px_oklch(0_0_0/0.35)] hover:bg-ink/4"
          >
            {t("chat.thread.newReplies")}
            <ArrowDownGlyph />
          </button>
        )}
      </div>
    </div>
  );
}
