import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { usePeople } from "../../data/queries";
import type { ChatMessageView, Person } from "../../data/types";
import { Markdown, type TextDecorator } from "../../tasks-ui/Markdown";
import { AttachmentChip } from "../claude/conversation/AttachmentChip";
import {
  CitationLink,
  HiddenCode,
  refKey,
  useCitationIndex,
} from "../claude/conversation/citations";
import { CODE_IN_TEXT } from "../claude/conversation/flow";
import { primaryButton, quietButton, WorkingRing } from "../claude/conversation/parts";
import { relativeTime } from "../../notifications/time";
import { hm } from "./flow";
import { MessageMenu, type MessageActions } from "./MessageMenu";
import { ReactionPicker, Reactions } from "./Reactions";

// Un messaggio del canale: nessuna bolla, nessun colore per autore. Il primo
// di un gruppo ha l'avatar 32px e «Nome · 16:02»; i successivi l'ora nel
// margine al passaggio. Al passaggio la riga prende la tinta d'inchiostro
// al 4% e compare la barra delle azioni. Il testo è il markdown della
// conversazione; i codici citati diventano codice + nome (R-E9 per chi non
// li vede), le menzioni sono in grassetto.

/** Il dischetto delle iniziali a 32px (l'avatar del flusso). */
export function ChatAvatar({
  person,
  size = 32,
}: {
  person: Person | null | undefined;
  size?: 20 | 32;
}) {
  const box = size === 32 ? "size-8 text-sm" : "size-[22px] text-xs";
  if (!person)
    return (
      <span
        aria-hidden="true"
        className={`${box} shrink-0 rounded-full border border-rule-strong`}
      />
    );
  return (
    <span
      aria-hidden="true"
      className={`grid ${box} shrink-0 place-items-center rounded-full font-semibold ${
        person.isClaude
          ? "border-[1.5px] border-dashed border-claude text-ink"
          : "bg-ink/10 text-ink"
      }`}
    >
      {person.initials}
    </span>
  );
}

/** Le menzioni nel testo: `@Nome Cognome`, `@channel`, `@Reparto`, `@Claude`. */
function mentionPattern(names: readonly string[]): RegExp | null {
  if (names.length === 0) return null;
  const escaped = [...names]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(@(?:${escaped.join("|")}))(?![\\p{L}\\p{N}_])`, "u");
}

/**
 * I codici nel testo: una citazione che chi legge vede diventa codice + nome
 * (il nome scritto subito dopo, come lo inserisce la casella, non si
 * ripete); una che non vede resta il solo codice tenue (R-E9) — il livello
 * dati non dà né nome né codice di ciò che non si vede, quindi un codice
 * senza vista visibile in un messaggio che cita qualcosa di invisibile è
 * quello. Le menzioni vanno in grassetto.
 */
export function useMessageDecorator(
  mentionNames: readonly string[],
  hasHidden: boolean,
): TextDecorator {
  const index = useCitationIndex();
  const mention = mentionPattern(mentionNames);
  return useCallback<TextDecorator>(
    (text, key) => {
      const out: ReactNode[] = [];
      const pushMentions = (chunk: string, k: string) => {
        if (!mention) return out.push(<Fragment key={k}>{chunk}</Fragment>);
        const parts = chunk.split(new RegExp(mention.source, "gu"));
        parts.forEach((part, i) => {
          if (i % 2 === 1) {
            out.push(
              <span key={`${k}-m${i}`} data-mention className="font-semibold text-ink">
                {part}
              </span>,
            );
          } else if (part) out.push(<Fragment key={`${k}-t${i}`}>{part}</Fragment>);
        });
      };
      const re = new RegExp(CODE_IN_TEXT.source, "g");
      let last = 0;
      let i = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const code = m[0];
        pushMentions(text.slice(last, m.index), `${key}-${i}`);
        let end = m.index + code.length;
        const view = index.byCode.get(code);
        if (view?.visible) {
          // «AUD-88 Invoice export check»: il nome scritto dopo è già nel link.
          if (view.name && text.startsWith(` ${view.name}`, end)) end += view.name.length + 1;
          out.push(<CitationLink key={`${key}-c${i}`} view={view} />);
        } else if (hasHidden) {
          out.push(<HiddenCode key={`${key}-c${i}`} code={code} />);
        } else {
          out.push(<Fragment key={`${key}-c${i}`}>{code}</Fragment>);
        }
        last = end;
        re.lastIndex = end;
        i += 1;
      }
      pushMentions(text.slice(last), `${key}-${i}`);
      return out;
    },
    [index, mention, hasHidden],
  );
}

export interface MessageItemProps {
  message: ChatMessageView;
  head: boolean;
  viewerId: string;
  /** Membro di un canale non archiviato. */
  canWrite: boolean;
  member: boolean;
  mentionNames: readonly string[];
  quick: readonly string[];
  frequent: readonly string[];
  threadHref: string;
  /** L'estratto della radice di una risposta «anche nel canale». */
  rootExcerpt: string | null;
  editing: boolean;
  onToggleReaction: (emoji: string) => void;
  onSaveEdit: (text: string) => Promise<void>;
  onCancelEdit: () => void;
  onConfirmDelete: () => Promise<void>;
  actions: Omit<MessageActions, "onQuickReact" | "onAddReaction" | "onDelete" | "replyHref">;
}

export function MessageItem(props: MessageItemProps) {
  const { message: m, head, viewerId, canWrite, member, threadHref } = props;
  const { t, i18n } = useTranslation();
  const people = usePeople().data;
  const author = people?.find((p) => p.id === m.authorId);
  const index = useCitationIndex();
  const hasHidden = m.citations.some((ref) => index.byRef.get(refKey(ref))?.visible === false);
  const decorate = useMessageDecorator(props.mentionNames, hasHidden);
  const [picker, setPicker] = useState<false | "below" | "above">(false);
  const row = useRef<HTMLDivElement>(null);
  /** Il selettore si apre sopra nella metà bassa della finestra. */
  const openPicker = () =>
    setPicker(
      (row.current?.getBoundingClientRect().top ?? 0) > window.innerHeight / 2 ? "above" : "below",
    );
  const [confirming, setConfirming] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const own = m.kind === "person" && m.authorId === viewerId;
  const deleted = m.deletedAt !== null;
  const canReact = canWrite && !deleted;

  const actions: MessageActions = {
    ...props.actions,
    replyHref: threadHref,
    onQuickReact: props.onToggleReaction,
    onAddReaction: openPicker,
    onDelete: () => {
      setDeleteFailed(false);
      setConfirming(true);
    },
  };

  // Le citazioni che il testo non nomina (pagine, file, progetti): in coda, codice + nome.
  const inText = new Set(m.text.match(new RegExp(CODE_IN_TEXT.source, "g")) ?? []);
  const extra = m.citations
    .map((ref) => index.byRef.get(refKey(ref)))
    .filter((v) => v !== undefined)
    // Un invisibile ha già il suo codice tenue nel testo, se il testo ne nomina.
    .filter((v) => !(v.code && inText.has(v.code)) && v.kind !== "person")
    .filter((v) => v.visible || inText.size === 0);
  const linked = m.linkedRefs
    .map((ref) => index.byRef.get(refKey(ref)))
    .filter((v) => v !== undefined);

  const time = (
    <time className="num" dateTime={m.createdAt}>
      {hm(m.createdAt, i18n.language)}
    </time>
  );
  const edited = m.editedAt && !deleted && (
    <span
      className="ml-1 text-xs text-ink-faint"
      title={t("chat.message.editedAt", { time: hm(m.editedAt, i18n.language) })}
    >
      {t("chat.message.edited")}
    </span>
  );

  return (
    <div
      ref={row}
      id={`message-${m.id}`}
      data-message={m.id}
      className={`group/message relative flex min-w-0 gap-3 rounded-md px-2 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 focus-within:bg-ink/4 ${head ? "mt-2 pt-1.5 pb-1" : "py-0.5"}`}
    >
      <div className="flex w-8 shrink-0 justify-center">
        {head && !deleted ? (
          <ChatAvatar person={author} />
        ) : (
          !deleted && (
            <span className="pt-0.5 text-xs leading-5 text-ink-faint opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100">
              {time}
            </span>
          )
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {m.alsoInChannel && m.threadOf && (
          <a
            href={threadHref}
            className="truncate text-xs text-ink-muted hover:text-ink"
            data-replied-to-thread
          >
            {t("chat.message.repliedToThread", { excerpt: props.rootExcerpt ?? "" })}
          </a>
        )}
        {head && !deleted && (
          <p className="flex min-w-0 items-baseline gap-1.5 text-sm">
            <span className="truncate font-semibold text-ink">{author?.name ?? ""}</span>
            <span aria-hidden="true" className="text-ink-faint">
              ·
            </span>
            <span className="text-xs text-ink-muted">{time}</span>
          </p>
        )}
        {deleted ? (
          <p className="py-0.5 text-sm text-ink-faint" data-deleted>
            {t("chat.message.deleted")}
          </p>
        ) : props.editing ? (
          <EditBox text={m.text} onSave={props.onSaveEdit} onCancel={props.onCancelEdit} />
        ) : (
          m.text && (
            <div className="min-w-0 max-w-[72ch]">
              <Markdown
                source={m.text}
                decorate={decorate}
                codeLabel={t("claude.conversation.codeBlock")}
                tableLabel={t("claude.conversation.table")}
                trailing={m.text.includes("|") ? undefined : edited || undefined}
              />
              {m.text.includes("|") && edited}
            </div>
          )
        )}
        {!deleted && extra.length > 0 && (
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 pt-0.5 text-sm">
            {extra.map((view) => (
              <CitationLink key={refKey(view)} view={view} />
            ))}
          </p>
        )}
        {!deleted && m.attachments.length > 0 && (
          <ul className="flex min-w-0 flex-wrap gap-1.5 pt-1">
            {m.attachments.map((a) => (
              <li key={a.id} className="min-w-0">
                <AttachmentChip attachment={a} />
              </li>
            ))}
          </ul>
        )}
        {!deleted && m.asksReplyOf.length > 0 && (
          <AsksLine message={m} people={people} viewerId={viewerId} />
        )}
        {!deleted && linked.length > 0 && (
          <p className="flex min-w-0 flex-wrap gap-x-3 pt-0.5 text-xs text-ink-muted" data-linked>
            {linked.map((view) => (
              <span key={refKey(view)} className="min-w-0 truncate">
                <span aria-hidden="true">→ </span>
                <span className="sr-only">{t("chat.message.linked")} </span>
                <CitationLink view={view} />
              </span>
            ))}
          </p>
        )}
        {!deleted && (
          <span className="relative">
            <Reactions
              reactions={m.reactions}
              viewerId={viewerId}
              canReact={canReact}
              onToggle={props.onToggleReaction}
              onAdd={openPicker}
            />
          </span>
        )}
        {m.thread && <ThreadLine message={m} href={threadHref} people={people} />}
        {confirming && (
          <p role="alert" className="flex flex-wrap items-center gap-2 pt-1 text-sm text-ink">
            {deleteFailed ? t("chat.message.deleteFailed") : t("chat.message.deleteConfirm")}
            <button
              type="button"
              className="inline-flex h-7 items-center rounded-md bg-critical px-3 text-sm font-semibold text-ground transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-90"
              onClick={() => {
                setDeleteFailed(false);
                props.onConfirmDelete().then(
                  () => setConfirming(false),
                  () => setDeleteFailed(true),
                );
              }}
            >
              {t("chat.actions.delete")}
            </button>
            <button
              type="button"
              className={`${quietButton} h-7`}
              onClick={() => setConfirming(false)}
            >
              {t("chat.message.cancel")}
            </button>
          </p>
        )}
      </div>
      {!deleted && !props.editing && (
        <MessageMenu
          actions={actions}
          quick={props.quick}
          canReact={canReact}
          canWrite={canWrite}
          own={own}
          member={member}
        />
      )}
      {picker && (
        <ReactionPicker
          frequent={props.frequent}
          placement={picker}
          onPick={(emoji) => {
            setPicker(false);
            if (!m.reactions.some((r) => r.emoji === emoji && r.personIds.includes(viewerId))) {
              props.onToggleReaction(emoji);
            }
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}

/** «Asks Giulia Ferri for a reply» → «Answered» quando tutte hanno risposto. */
function AsksLine({
  message,
  people,
  viewerId,
}: {
  message: ChatMessageView;
  people: Person[] | undefined;
  viewerId: string;
}) {
  const { t } = useTranslation();
  const waiting = message.asksReplyOf.filter((id) => !message.answeredIds.includes(id));
  if (waiting.length === 0) {
    return <p className="pt-0.5 text-xs text-ink-muted">{t("chat.message.answered")}</p>;
  }
  if (waiting.length === 1 && waiting[0] === viewerId) {
    return <p className="pt-0.5 text-xs font-semibold text-ink">{t("chat.message.asksYou")}</p>;
  }
  const names = waiting.map((id) => people?.find((p) => p.id === id)?.name ?? "").join(", ");
  return <p className="pt-0.5 text-xs text-ink-muted">{t("chat.message.asks", { names })}</p>;
}

/** «(GF)(EM) 4 replies · Last reply by Elena Moretti · 2h ago»; il punto pieno per le novità. */
function ThreadLine({
  message,
  href,
  people,
}: {
  message: ChatMessageView;
  href: string;
  people: Person[] | undefined;
}) {
  const { t, i18n } = useTranslation();
  const thread = message.thread!;
  const last = people?.find((p) => p.id === thread.lastReplyById);
  return (
    <a
      href={href}
      data-thread-summary
      className="-ml-1 mt-1 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-ink/6"
    >
      {thread.hasNews && (
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ink" />
      )}
      {thread.hasNews && <span className="sr-only">{t("chat.message.newReplies")}</span>}
      <span className="flex shrink-0 -space-x-1">
        {thread.participantIds.map((id) => (
          <span key={id} className="rounded-full bg-ground ring-2 ring-ground">
            <ChatAvatar person={people?.find((p) => p.id === id)} size={20} />
          </span>
        ))}
      </span>
      <span className="num shrink-0 font-semibold text-ink">
        {t("chat.message.replies", { count: thread.replyCount })}
      </span>
      {thread.claudeReplying ? (
        <span className="flex min-w-0 items-center gap-1.5 text-ink-muted">
          <WorkingRing />
          <span className="truncate">{t("chat.message.claudeReplying")}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate text-ink-muted">
          {t("chat.message.lastReply", {
            name: last?.name ?? "",
            time: relativeTime(thread.lastReplyAt, t, i18n.language),
          })}
        </span>
      )}
    </a>
  );
}

/** La modifica sul posto: Invio salva, Maiusc+Invio va a capo, Esc annulla. */
function EditBox({
  text,
  onSave,
  onCancel,
}: {
  text: string;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(text);
  const [failed, setFailed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 216)}px`;
  }, [value]);
  const save = () => {
    if (!value.trim()) return;
    setFailed(false);
    onSave(value).catch(() => setFailed(true));
  };
  return (
    <div className="flex min-w-0 flex-col gap-1 py-1">
      <textarea
        ref={field}
        value={value}
        rows={1}
        aria-label={t("chat.message.editLabel")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
        className="block max-h-[216px] w-full resize-none rounded-lg border border-rule-strong bg-surface px-3 py-2 text-md text-ink outline-none focus:border-ink/45"
      />
      <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        {failed ? (
          <span role="alert" className="text-critical">
            {t("chat.message.editFailed")}
          </span>
        ) : (
          <span>{t("chat.message.editHint")}</span>
        )}
        <button type="button" className={`${quietButton} h-7`} onClick={onCancel}>
          {t("chat.message.cancel")}
        </button>
        <button type="button" className={`${primaryButton} h-7`} onClick={save}>
          {t("chat.message.save")}
        </button>
      </p>
    </div>
  );
}
