import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useChatChannels,
  useThreadsWithNews,
  usePeople,
  useProjects,
  useSessionPersonId,
} from "../../data/queries";
import type { ChannelRow, ChatMessageView, Person } from "../../data/types";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { rowLabel } from "./ChatPage";
import { hm } from "./flow";
import { ChatAvatar } from "./MessageItem";

// «Threads» (shape chat.md §6): i thread che chi guarda segue con risposte
// nuove, dal più recente. Ogni riga: il canale, l'estratto della radice, le
// ultime due risposte; il clic apre il pannello del thread sul suo canale.

/** La prima riga di un messaggio senza markdown, per un estratto. */
export function excerpt(text: string, max = 140): string {
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
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** La testata di una vista della Chat: l'h1 a 28px e una riga che dice cosa contiene. */
export function ChatViewHeader({ title, lede }: { title: string; lede: string }) {
  return (
    <header className="page-header flex flex-col gap-1 border-b border-rule pb-4 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <h1 className="text-2xl font-semibold text-ink">{title}</h1>
      <p className="text-sm text-ink-muted">{lede}</p>
    </header>
  );
}

/** Il canale di una riga: «AUD · general» con il codice in cifre tabellari. */
export function ChannelTag({
  channelId,
  rows,
  me,
  people,
}: {
  channelId: string;
  rows: ChannelRow[] | undefined;
  me: string;
  people: Person[] | undefined;
}) {
  const projects = useProjects().data;
  const row = rows?.find((r) => r.id === channelId);
  if (!row) return null;
  const name = rowLabel(row, me, projects, people);
  return (
    <span className="min-w-0 truncate text-sm text-ink-muted" title={name.label}>
      {name.code && (
        <span className="num font-semibold">
          {name.prefix}
        </span>
      )}
      {name.name}
    </span>
  );
}

/** Una riga «chi · ora · testo» di un estratto. */
export function ExcerptLine({
  message,
  people,
  strong = false,
}: {
  message: ChatMessageView;
  people: Person[] | undefined;
  strong?: boolean;
}): ReactNode {
  const { t, i18n } = useTranslation();
  const author = people?.find((p) => p.id === message.authorId);
  const text = message.deletedAt ? t("chat.message.deleted") : excerpt(message.text);
  return (
    <span className="flex min-w-0 items-start gap-2">
      <ChatAvatar person={author} size={20} />
      <span className="min-w-0 flex-1">
        <span className={`text-sm ${strong ? "font-semibold text-ink" : "font-medium text-ink"}`}>
          {author?.name ?? t("chat.views.system")}
        </span>
        <span className="num ml-1.5 text-xs text-ink-faint">{hm(message.createdAt, i18n.language)}</span>
        <span
          className={`block line-clamp-2 text-md [overflow-wrap:anywhere] ${
            message.deletedAt ? "text-ink-faint" : "text-ink"
          }`}
        >
          {text}
        </span>
      </span>
    </span>
  );
}

export function ThreadsView() {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const threads = useThreadsWithNews();
  const rows = useChatChannels().data;
  const people = usePeople().data;
  return (
    <section className="flex min-h-full flex-col">
      <ChatViewHeader title={t("chat.views.threadsTitle")} lede={t("chat.views.threadsLede")} />
      <div className="max-w-[820px] px-4">
        {threads.isError ? (
          <PageError message={t("chat.views.threadsError")} onRetry={() => void threads.refetch()} />
        ) : threads.isPending ? (
          <PageSkeleton rows={4} />
        ) : threads.data.length === 0 ? (
          <PageEmpty title={t("chat.views.threadsEmpty")} body={t("chat.views.threadsEmptyBody")} />
        ) : (
          <ul className="flex flex-col">
            {threads.data.map((thread) => (
              <li key={thread.root.id} className="border-b border-rule">
                <Link
                  to="/chat/$channelId"
                  params={{ channelId: thread.channelId }}
                  search={{ thread: thread.root.id }}
                  data-thread-row={thread.root.id}
                  className="flex flex-col gap-2 rounded-md px-4 py-3 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ChannelTag channelId={thread.channelId} rows={rows} me={me} people={people} />
                    <span className="ml-auto shrink-0 text-xs font-semibold text-ink">
                      {t("chat.views.newReplies", { count: thread.newCount })}
                    </span>
                  </span>
                  <ExcerptLine message={thread.root} people={people} />
                  <span className="ml-7 flex flex-col gap-2 border-l border-rule pl-3">
                    {thread.latestReplies.map((reply) => (
                      <ExcerptLine key={reply.id} message={reply} people={people} />
                    ))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
