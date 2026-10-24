import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { getSessionPersonId } from "../../data/session";
import { useTranslation } from "react-i18next";
import {
  useArchiveChannel,
  useChannelMessages,
  useChannelStream,
  useChatChannel,
  useChatMessage,
  useCitations,
  useCodeCitations,
  useDeleteChatMessage,
  useDepartments,
  useEditChatMessage,
  useJoinChannel,
  useLeaveChannel,
  useMarkChannelRead,
  usePeople,
  useProjects,
  useSendChatMessage,
  useSessionPersonId,
  useToggleReaction,
} from "../../data/queries";
import type {
  ChannelMessagesPage,
  ChannelView as ChannelData,
  ChatMessageView,
  CitationRef,
} from "../../data/types";
import { copyText } from "../../tasks-ui/exportFile";
import { itemClass, MenuGroup } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { formatDate } from "../../notifications/time";
import { CitationProvider, indexCitations } from "../claude/conversation/citations";
import { AttachmentChip } from "../claude/conversation/AttachmentChip";
import { CODE_IN_TEXT } from "../claude/conversation/flow";
import type { DraftAttachment } from "../claude/conversation/Composer";
import { primaryButton, secondaryButton } from "../claude/conversation/parts";
import { NewRequestDialog } from "../requests/NewRequestDialog";
import { NewTaskDialog } from "../task/NewTaskDialog";
import { MenuButton } from "../tasks/controls";
import { callsClaude, ChatComposer, type ChatSendInput } from "./ChatComposer";
import { mostUsed } from "./emoji";
import { flowDays, mergeFlow, type FlowRow } from "./flow";
import { ChatAvatar, MessageItem } from "./MessageItem";
import { MessageList } from "./MessageList";
import { PrivateChannelPage } from "./PrivateChannelPage";
import { BackToResults } from "./ChatSearch";
import { SystemCard } from "./SystemCard";
import { channelName, type ChannelName } from "../../domain/chatLabel";

// Il canale: testata (nome, aperto/privato, membri, argomento, «People
// only», «⋯»), il flusso e la casella — o, al posto della casella, la
// fascia di un archiviato o di un aperto in cui non si è entrati. Lo stesso
// componente vive nella Chat e nella sezione Chat del progetto: gli stessi
// messaggi, gli stessi letti. Chi lo monta lo chiave per persona e canale,
// così cambiare persona non lascia nulla di chi guardava prima (flusso,
// riga «New», bozza, invii a metà).

const PAGE = 50;
const CODE_RE = new RegExp(CODE_IN_TEXT.source, "g");
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Dopo quanto un invio che non ha ancora risposto dice «Sending…». */
const SLOW_SEND_MS = 1000;
/** Gli arrivi entro questo tempo si annunciano insieme (ms). */
export const ANNOUNCE_MS = 600;

/** Dove portano i link del canale (thread, messaggio): la Chat o la sezione del progetto. */
export type ChannelHref = (params: { thread?: string; message?: string }) => string;

/**
 * Va a un link della Chat (`#/chat/…`) dalla cronologia del router (anche
 * in memoria nei test); fuori da un router, dall'hash dell'indirizzo.
 */
function useOpenHref(): (href: string, as: { personId: string; from: string }) => void {
  const router = useRouter({ warn: false });
  return useCallback(
    (href: string, as: { personId: string; from: string }) => {
      // Solo se chi guarda e la pagina sono ancora quelli dell'invio: una
      // risposta arrivata dopo un cambio di persona o di pagina non porta via.
      if (getSessionPersonId() !== as.personId) return;
      const here = router
        ? router.state.location.pathname
        : window.location.hash.replace(/^#/, "").split("?")[0];
      if (here !== as.from.replace(/^#/, "").split("?")[0]) return;
      const path = href.replace(/^#/, "");
      if (router) router.history.push(path);
      else window.location.hash = path;
    },
    [router],
  );
}

export const chatHref =
  (channelId: string): ChannelHref =>
  ({ thread, message }) => {
    const search = new URLSearchParams();
    if (thread) search.set("thread", thread);
    if (message) search.set("message", message);
    const q = search.toString();
    return `#/chat/${channelId}${q ? `?${q}` : ""}`;
  };

interface LocalSend {
  key: number;
  input: ChatSendInput;
  state: "sending" | "failed";
  slow: boolean;
}

/** Un istante subito prima di `iso` («Mark unread from here»). */
const justBefore = (iso: string) =>
  new Date(Date.parse(iso) - 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** La prima riga del messaggio, senza markdown: il titolo di «Create task/request». */
function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) =>
        l
          .replace(/^[#>*\-\s]+/, "")
          .replace(/[*_`]/g, "")
          .trim(),
      )
      .find(Boolean) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export function ChannelView({
  channelId,
  hrefFor = chatHref(channelId),
  focusMessageId,
  openThreadId,
}: {
  channelId: string;
  hrefFor?: ChannelHref;
  focusMessageId?: string | undefined;
  /** La radice del thread aperto nel pannello (`?thread=`): prende la tinta di selezione. */
  openThreadId?: string | undefined;
}) {
  const { t } = useTranslation();
  const channel = useChatChannel(channelId);
  if (channel.isError) {
    return (
      <section className="p-8">
        <PageError message={t("chat.channel.error")} onRetry={() => void channel.refetch()} />
      </section>
    );
  }
  if (channel.isPending) return <ChannelSkeleton />;
  if (!channel.data) {
    return (
      <section className="page-header flex flex-col gap-2 pb-8 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <h1 className="text-2xl font-semibold text-ink">{t("chat.channel.notFoundTitle")}</h1>
        <p className="text-md text-ink-muted">{t("chat.channel.notFound")}</p>
      </section>
    );
  }
  // Un privato che si gestisce senza esserne membri: esiste, non si legge.
  if (!channel.data.canRead) return <PrivateChannelPage channel={channel.data} />;
  return (
    <ChannelBody
      channel={channel.data}
      hrefFor={hrefFor}
      focusMessageId={focusMessageId}
      openThreadId={openThreadId}
    />
  );
}

function ChannelSkeleton() {
  const { t } = useTranslation();
  return (
    <section aria-busy="true" className="skeleton-breathe flex flex-col gap-6 px-8 pt-8">
      <span role="status" className="sr-only">
        {t("chat.channel.loading")}
      </span>
      <span className="h-7 w-64 rounded-md bg-ink/8" />
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className="flex gap-3">
          <span className="size-8 shrink-0 rounded-full bg-ink/8" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-3 w-40 rounded bg-ink/8" />
            <span className="h-3 rounded bg-ink/6" style={{ width: `${40 + ((i * 17) % 45)}%` }} />
          </span>
        </span>
      ))}
    </section>
  );
}

/** Il nome del canale: «AUD · general» (codice tabellare muted), «# announcements», i nomi del DM. */
export function useChannelName(channel: ChannelData, me: string): ChannelName {
  const projects = useProjects().data;
  const people = usePeople().data;
  return channelName(
    channel,
    me,
    (id) => projects?.find((p) => p.id === id)?.code,
    (id) => people?.find((p) => p.id === id)?.name,
  );
}

function ChannelBody({
  channel,
  hrefFor,
  focusMessageId,
  openThreadId,
}: {
  channel: ChannelData;
  hrefFor: ChannelHref;
  focusMessageId?: string | undefined;
  openThreadId?: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const me = useSessionPersonId();
  const toast = useToast();
  const people = usePeople().data;
  const departments = useDepartments().data;
  const name = useChannelName(channel, me);
  const [limit, setLimit] = useState(PAGE);
  const query = useChannelMessages(channel.id, limit);
  const stream = useChannelStream(channel.id);
  // Caricando i più vecchi la pagina precedente resta a schermo.
  const lastPage = useRef<ChannelMessagesPage | null>(null);
  if (query.data) lastPage.current = query.data;
  const page = query.data ?? lastPage.current;
  const [peopleOnly, setPeopleOnly] = useState(false);
  // La riga «New»: fin dove si era letto entrando; resta finché si esce dal canale.
  const [readAt, setReadAt] = useState<string | null | undefined>(undefined);
  if (page && readAt === undefined) setReadAt(page.lastReadAt);
  const markedUpTo = useRef<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{
    kind: "task" | "request";
    message: ChatMessageView;
  } | null>(null);
  const [local, setLocal] = useState<LocalSend[]>([]);
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const nextKey = useRef(0);
  const send = useSendChatMessage();
  const edit = useEditChatMessage();
  const remove = useDeleteChatMessage();
  const react = useToggleReaction();
  const markRead = useMarkChannelRead();
  const openHref = useOpenHref();
  const join = useJoinChannel();
  const leave = useLeaveChannel();
  const archive = useArchiveChannel();

  // Il messaggio da raggiungere (la radice, se il thread è aperto: lì
  // l'evidenza è nel pannello). Se è più vecchio della pagina letta si
  // caricano i precedenti finché arriva (la ricerca trova anche i vecchi).
  const reachId = openThreadId ?? focusMessageId;
  // Senza `?thread=` prima si sa dov'è il messaggio: una risposta che sta
  // solo nel thread apre il pannello (e lì si evidenzia) invece di far
  // sfogliare al canale tutta la storia; uno che non si legge non si cerca.
  const navigate = useNavigate();
  const focusRead = useChatMessage(focusMessageId ?? "", {
    enabled: !!focusMessageId && !openThreadId,
  });
  const focused = focusRead.data?.message;
  const threadOnlyRoot =
    focused && focused.threadOf !== null && !focused.alsoInChannel ? focused.threadOf : null;
  useEffect(() => {
    if (!threadOnlyRoot || openThreadId) return;
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, thread: threadOnlyRoot }),
      replace: true,
    } as never);
  }, [threadOnlyRoot, openThreadId, navigate]);
  const inFlow = !!openThreadId || (!!focused && threadOnlyRoot === null);
  const fetching = query.isFetching;
  useEffect(() => {
    if (!reachId || !inFlow || !page?.hasMore || fetching) return;
    if (page.messages.some((m) => m.id === reachId)) return;
    setLimit((n) => n + PAGE);
  }, [reachId, inFlow, page, fetching]);

  const messages = useMemo(
    () => (page ? mergeFlow(page.messages, stream.messages, page.hasMore) : []),
    [page, stream.messages],
  );
  const days = useMemo(
    () => flowDays(messages, { viewerId: me, lastReadAt: readAt ?? null, peopleOnly }),
    [messages, me, readAt, peopleOnly],
  );

  // Le citazioni del flusso, lette una volta per chi guarda (R-E9).
  const refs = useMemo(() => {
    const out: CitationRef[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
      for (const ref of [...m.citations, ...m.linkedRefs, ...(m.event ? [m.event.ref] : [])]) {
        const k = `${ref.kind}:${ref.id}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push(ref);
        }
      }
    }
    return out;
  }, [messages]);
  const citations = useCitations(refs);
  // I codici scritti a mano e non citati: anche loro si leggono per chi guarda.
  const codes = useMemo(() => {
    const found = new Set<string>();
    for (const m of messages) for (const c of m.text.match(CODE_RE) ?? []) found.add(c);
    return [...found].sort();
  }, [messages]);
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
        messages.flatMap((m) => m.reactions),
        me,
      ),
    [messages, me],
  );

  const latest = messages.at(-1)?.createdAt ?? null;
  const onAtBottom = useCallback(() => {
    if (!channel.isMember || latest === null) return;
    if (markedUpTo.current !== null && markedUpTo.current >= latest) return;
    if (readAt && readAt >= latest && markedUpTo.current === null) {
      markedUpTo.current = latest;
      return;
    }
    markedUpTo.current = latest;
    markRead.mutate({ channelId: channel.id });
  }, [channel.isMember, channel.id, latest, readAt, markRead]);

  // --- arrivi dal vivo: annunciati insieme, mai uno per uno. Il flusso
  // (`role="log"`) ha `aria-live="off"`: parla solo questa regione, una volta
  // per ondata (gli arrivi entro `ANNOUNCE_MS` si sommano) ---
  const [announce, setAnnounce] = useState("");
  const arrived = useRef<number | null>(null);
  const pending = useRef(0);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(announceTimer.current), []);
  useEffect(() => {
    const fresh = stream.messages.filter((m) => m.authorId !== me && m.threadOf === null).length;
    if (arrived.current === null) {
      arrived.current = fresh;
      return;
    }
    if (fresh > arrived.current) {
      pending.current += fresh - arrived.current;
      clearTimeout(announceTimer.current);
      announceTimer.current = setTimeout(() => {
        setAnnounce(t("chat.flow.arrived", { count: pending.current }));
        pending.current = 0;
      }, ANNOUNCE_MS);
    }
    arrived.current = fresh;
  }, [stream.messages, me, t]);

  // --- allegati: graffetta, incolla, trascina; 10 file da 20 MB ---
  const addFiles = useCallback(
    (files: File[]) => {
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
          const image = file.type.startsWith("image/");
          nextKey.current += 1;
          next.push({
            attachment: {
              id: `att-chat-${nextKey.current}`,
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
    [channel.canWrite, t],
  );
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  useEffect(
    () => () => {
      for (const d of draftsRef.current) if (d.previewUrl) URL.revokeObjectURL?.(d.previewUrl);
    },
    [],
  );

  // --- invio: «Sending…» dopo 1 s, «Not sent · Resend · Delete» se non passa ---
  const deliver = (key: number, input: ChatSendInput) => {
    const timer = setTimeout(
      () => setLocal((list) => list.map((l) => (l.key === key ? { ...l, slow: true } : l))),
      SLOW_SEND_MS,
    );
    // `mutateAsync`: con più invii in volo i callback di `mutate` scattano solo per l'ultimo.
    send
      .mutateAsync({
        channelId: channel.id,
        input: {
          text: input.text,
          ...(input.attachments.length ? { attachments: input.attachments } : {}),
          ...(input.citations.length ? { citations: input.citations } : {}),
          ...(input.asksReply ? { asksReply: true } : {}),
        },
      })
      .then(
        (sent) => {
          setLocal((list) => list.filter((l) => l.key !== key));
          // «@Claude» nel canale: la risposta nasce nel thread, e per chi
          // l'ha chiamato il pannello si apre da solo su quel thread.
          if (callsClaude(sent.text)) {
            openHref(hrefFor({ thread: sent.id }), { personId: me, from: hrefFor({}) });
          }
        },
        () =>
          setLocal((list) =>
            list.map((l) => (l.key === key ? { ...l, state: "failed", slow: false } : l)),
          ),
      )
      .finally(() => clearTimeout(timer));
  };
  const onSend = (input: ChatSendInput) => {
    nextKey.current += 1;
    const key = nextKey.current;
    setLocal((list) => [...list, { key, input, state: "sending", slow: false }]);
    setDrafts([]);
    setAttachError(null);
    deliver(key, input);
  };
  const resend = (key: number) => {
    const entry = local.find((l) => l.key === key);
    if (!entry) return;
    setLocal((list) => list.map((l) => (l.key === key ? { ...l, state: "sending" } : l)));
    deliver(key, entry.input);
  };

  const editLast = () => {
    const mine = [...messages]
      .reverse()
      .find((m) => m.kind === "person" && m.authorId === me && m.deletedAt === null);
    if (!mine) return false;
    setEditingId(mine.id);
    return true;
  };

  const copyLink = (m: ChatMessageView) => {
    const base =
      typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : "";
    copyText(`${base}${chatHref(channel.id)({ message: m.id })}`).then(
      () => toast.show(t("chat.actions.linkCopied")),
      () => toast.error(t("chat.actions.copyFailed")),
    );
  };

  const markUnreadFrom = (m: ChatMessageView) => {
    const at = justBefore(m.createdAt);
    markedUpTo.current = latest;
    setReadAt(at);
    markRead.mutate({ channelId: channel.id, at });
  };

  const rootExcerpt = (m: ChatMessageView) => {
    if (!m.threadOf) return null;
    const root = messages.find((x) => x.id === m.threadOf);
    const text = root ? firstLine(root.text) : "";
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  };

  const renderRow = (row: FlowRow, key: string) => {
    if (row.kind === "system") {
      return <SystemCard key={key} eventKind={row.eventKind} messages={row.messages} />;
    }
    if (row.kind !== "message") return null;
    const m = row.message;
    return (
      <MessageItem
        key={m.id}
        message={m}
        head={row.head}
        selected={openThreadId !== undefined && m.id === openThreadId}
        viewerId={me}
        canWrite={channel.canWrite}
        member={channel.isMember}
        mentionNames={mentionNames}
        quick={frequent.slice(0, 3)}
        frequent={frequent}
        threadHref={hrefFor({ thread: m.threadOf ?? m.id })}
        rootExcerpt={rootExcerpt(m)}
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
          onCopyLink: () => copyLink(m),
          onMarkUnread: () => markUnreadFrom(m),
          onCreateTask: () => setCreating({ kind: "task", message: m }),
          onCreateRequest: () => setCreating({ kind: "request", message: m }),
          onEdit: () => setEditingId(m.id),
        }}
      />
    );
  };

  const me_ = people?.find((p) => p.id === me);
  const tail =
    local.length > 0 ? (
      <ol aria-label={t("chat.message.outbox")} className="flex flex-col">
        {local.map((l) => (
          <li
            key={l.key}
            className="mt-2 flex min-w-0 gap-3 px-2 pt-1.5"
            data-local-send={l.state}
            role={l.state === "failed" ? "alert" : undefined}
          >
            <ChatAvatar person={me_} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-semibold text-ink">{me_?.name ?? ""}</span>
              {l.input.text && (
                <p className="min-w-0 max-w-[72ch] text-md whitespace-pre-wrap text-ink-muted [overflow-wrap:anywhere]">
                  {l.input.text}
                </p>
              )}
              {l.input.attachments.length > 0 && (
                <ul className="flex min-w-0 flex-wrap gap-1.5 pt-1 opacity-70">
                  {l.input.attachments.map((a) => (
                    <li key={a.id} className="min-w-0">
                      <AttachmentChip attachment={a} />
                    </li>
                  ))}
                </ul>
              )}
              {l.state === "failed" ? (
                <p className="text-xs">
                  <span className="font-semibold text-critical">{t("chat.message.notSent")}</span>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => resend(l.key)}
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
              ) : (
                l.slow && <p className="text-xs text-ink-muted">{t("chat.message.sending")}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    ) : null;

  const creator = people?.find((p) => p.id === channel.createdById);
  const intro = (
    <div className="flex flex-col gap-1 px-2 pt-6 pb-4" data-channel-intro>
      <p className="text-lg font-semibold text-ink [overflow-wrap:anywhere]">
        {channel.kind === "dm"
          ? t("chat.channel.startDm", { name: name.label })
          : t("chat.channel.start", { name: name.label })}
      </p>
      {channel.description && <p className="text-md text-ink-muted">{channel.description}</p>}
      <p className="text-sm text-ink-muted">
        {t("chat.channel.createdBy", {
          name: creator?.name ?? "",
          date: formatDate(channel.createdAt, i18n.language),
        })}
      </p>
    </div>
  );

  const onDrag = (e: DragEvent<HTMLElement>, over: boolean) => {
    if (!channel.canWrite || !e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    setDragging(over);
  };

  return (
    <CitationProvider value={index}>
      <section
        aria-label={name.label}
        data-channel={channel.id}
        className="@container relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden"
        onKeyDown={(e) => {
          // Esc nel canale = «Mark as read» (un menu o la casella lo fermano prima, se è loro).
          if (e.key === "Escape" && !e.defaultPrevented && channel.isMember && latest) {
            markedUpTo.current = latest;
            markRead.mutate({ channelId: channel.id });
          }
        }}
        onDragEnter={(e) => onDrag(e, true)}
        onDragOver={(e) => onDrag(e, true)}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          if (!channel.canWrite) return;
          e.preventDefault();
          setDragging(false);
          addFiles([...(e.dataTransfer?.files ?? [])]);
        }}
      >
        <ChannelHeader
          channel={channel}
          name={name}
          peopleOnly={peopleOnly}
          onPeopleOnly={() => setPeopleOnly((v) => !v)}
          onCopyLink={() => {
            const base =
              typeof window !== "undefined"
                ? `${window.location.origin}${window.location.pathname}`
                : "";
            copyText(`${base}${chatHref(channel.id)({})}`).then(
              () => toast.show(t("chat.actions.linkCopied")),
              () => toast.error(t("chat.actions.copyFailed")),
            );
          }}
          onMarkRead={() => {
            if (latest) markedUpTo.current = latest;
            markRead.mutate({ channelId: channel.id });
          }}
          onLeave={() =>
            leave.mutate(channel.id, { onError: () => toast.error(t("chat.channel.leaveFailed")) })
          }
        />
        <BackToResults messageId={focusMessageId} />
        {query.isError && !page ? (
          <div className="px-4">
            <PageError message={t("chat.channel.error")} onRetry={() => void query.refetch()} />
          </div>
        ) : !page ? (
          <ChannelSkeleton />
        ) : (
          <MessageList
            days={days}
            hasMore={page.hasMore}
            loadingEarlier={query.isFetching && !query.data}
            onLoadEarlier={() => setLimit((n) => n + PAGE)}
            renderRow={renderRow}
            onAtBottom={onAtBottom}
            focusId={reachId}
            flashFocus={!openThreadId}
            tail={tail}
            intro={intro}
            label={t("chat.flow.label", { name: name.label })}
            announce={announce}
          />
        )}
        {channel.canRead && (
          <>
            {channel.archived ? (
              <Band>
                <span>
                  {channel.archivedById && channel.archivedAt
                    ? t("chat.channel.archivedBandBy", {
                        name: people?.find((p) => p.id === channel.archivedById)?.name ?? "",
                        date: formatDate(channel.archivedAt, i18n.language),
                      })
                    : t("chat.channel.archivedBand")}
                </span>
                {channel.canArchive && (
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() =>
                      archive.mutate(
                        { id: channel.id, archived: false },
                        { onError: () => toast.error(t("chat.channel.unarchiveFailed")) },
                      )
                    }
                  >
                    {t("chat.channel.unarchive")}
                  </button>
                )}
              </Band>
            ) : !channel.isMember ? (
              <Band>
                <span>{t("chat.channel.notMember")}</span>
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
              </Band>
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
              />
            )}
          </>
        )}
        {dragging && (
          <div
            aria-hidden="true"
            className="event-enter pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-dashed border-ink/50 bg-ground/85 text-md font-semibold text-ink"
          >
            {t("claude.conversation.attachments.drop")}
          </div>
        )}
        {creating?.kind === "task" && (
          <NewTaskDialog
            {...(channel.projectId ? { projectId: channel.projectId } : {})}
            fromMessageId={creating.message.id}
            initial={{
              title: firstLine(creating.message.text),
              description: `${creating.message.text}\n\n${messageLink(channel.id, creating.message.id)}`,
            }}
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
            initial={{
              title: firstLine(creating.message.text),
              description: `${creating.message.text}\n\n${messageLink(channel.id, creating.message.id)}`,
            }}
            onCreated={(request) => {
              setCreating(null);
              toast.show(t("chat.actions.requestCreated", { code: request.code }));
            }}
            onClose={() => setCreating(null)}
          />
        )}
      </section>
    </CitationProvider>
  );
}

/** Il link a un messaggio scritto nella descrizione di una task o richiesta che ne nasce. */
const messageLink = (channelId: string, messageId: string) =>
  `[Chat message](${chatHref(channelId)({ message: messageId })})`;

function Band({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      data-channel-band
      className="mx-8 mt-2 mb-5 flex max-w-[760px] min-w-0 flex-wrap items-center justify-between gap-3 border-t border-rule pt-3 text-md text-ink-muted @max-[620px]:mx-4"
    >
      {children}
    </div>
  );
}

/** Apre le impostazioni del canale (`?settings=1`): chiudono il thread, se era aperto. */
export function useOpenChannelSettings(): () => void {
  const navigate = useNavigate();
  return () =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, thread: undefined, settings: "1" }),
    } as never);
}

function ChannelHeader({
  channel,
  name,
  peopleOnly,
  onPeopleOnly,
  onCopyLink,
  onMarkRead,
  onLeave,
}: {
  channel: ChannelData;
  name: ChannelName;
  peopleOnly: boolean;
  onPeopleOnly: () => void;
  onCopyLink: () => void;
  onMarkRead: () => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const people = usePeople().data;
  const openSettings = useOpenChannelSettings();
  const settingsHintId = useId();
  const shown = channel.memberIds.slice(0, 3);
  const meta = [
    channel.archived
      ? t("chat.channel.archived")
      : channel.kind === "dm"
        ? t("chat.channel.dm")
        : channel.visibility === "open"
          ? t("chat.channel.open")
          : t("chat.channel.private"),
    t("chat.channel.members", { count: channel.memberIds.length }),
  ];
  return (
    <header className="page-header flex min-w-0 flex-col gap-1 border-b border-rule pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:24px] @max-[620px]:pl-4">
      <div className="flex min-w-0 items-start gap-4">
        <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold text-ink" title={name.label}>
          {/* Il nome apre le impostazioni (shape chat-manage.md §3), restando il titolo. */}
          <button
            type="button"
            onClick={openSettings}
            title={t("chat.channel.settings")}
            aria-describedby={settingsHintId}
            className="max-w-full truncate rounded-md text-left transition-colors duration-[var(--duration-fast)] ease-out hover:text-ink/80"
          >
            {name.code && (
              <span className="num text-ink-muted">
                {name.prefix}
              </span>
            )}
            {name.name}
          </button>
        </h1>
        {/* Fuori dall'h1: il titolo resta il solo nome del canale. */}
        <span id={settingsHintId} className="sr-only">
          {t("chat.channel.openSettings")}
        </span>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          <button
            type="button"
            onClick={openSettings}
            className="flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
            aria-label={t("chat.channel.membersOpen", { count: channel.memberIds.length })}
          >
            <span className="flex gap-0.5" aria-hidden="true">
              {shown.map((id) => (
                <span key={id} className="rounded-full">
                  <ChatAvatar person={people?.find((p) => p.id === id)} size={20} />
                </span>
              ))}
            </span>
            <span className="num" aria-hidden="true">
              {channel.memberIds.length}
            </span>
          </button>
          {channel.kind !== "dm" && (
            <button
              type="button"
              aria-pressed={peopleOnly}
              onClick={onPeopleOnly}
              className={`inline-flex h-8 items-center rounded-md border px-2.5 text-sm font-medium transition-colors duration-[var(--duration-fast)] ease-out ${
                peopleOnly
                  ? "border-rule-strong bg-ink/10 text-ink"
                  : "border-rule text-ink-muted hover:bg-ink/6 hover:text-ink"
              }`}
            >
              {t("chat.channel.peopleOnly")}
            </button>
          )}
          <MenuButton
            menuLabel={t("chat.channel.more")}
            ariaLabel={t("chat.channel.more")}
            title={t("chat.channel.more")}
            align="right"
            className="grid size-8 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink"
            label={
              <svg
                viewBox="0 0 16 16"
                width={16}
                height={16}
                aria-hidden="true"
                fill="currentColor"
              >
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
                    openSettings();
                  }}
                >
                  {channel.kind === "dm" ? t("chat.channel.details") : t("chat.channel.settings")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={itemClass}
                  onClick={() => {
                    close();
                    onCopyLink();
                  }}
                >
                  {t("chat.channel.copyLink")}
                </button>
                {channel.isMember && (
                  <button
                    type="button"
                    role="menuitem"
                    className={itemClass}
                    onClick={() => {
                      close();
                      onMarkRead();
                    }}
                  >
                    {t("chat.channel.markRead")}
                  </button>
                )}
                {channel.isMember && channel.canLeave && (
                  <button
                    type="button"
                    role="menuitem"
                    className={itemClass}
                    onClick={() => {
                      close();
                      onLeave();
                    }}
                  >
                    {t("chat.channel.leave")}
                  </button>
                )}
              </MenuGroup>
            )}
          </MenuButton>
        </div>
      </div>
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm text-ink-muted">
        <span>{meta.join(" · ")}</span>
        {channel.topic && (
          <>
            <span aria-hidden="true">·</span>
            {channel.canEditTopic ? (
              <button
                type="button"
                onClick={openSettings}
                title={channel.topic}
                className="min-w-0 truncate text-left underline decoration-ink/20 underline-offset-2 hover:text-ink hover:decoration-ink/60"
              >
                {t("chat.channel.topic", { topic: channel.topic })}
              </button>
            ) : (
              <span className="min-w-0 truncate" title={channel.topic}>
                {t("chat.channel.topic", { topic: channel.topic })}
              </span>
            )}
          </>
        )}
      </p>
    </header>
  );
}
