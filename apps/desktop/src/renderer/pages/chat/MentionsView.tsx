import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../data/dates";
import {
  useChatChannels,
  useChatMentions,
  usePeople,
  useSessionPersonId,
} from "../../data/queries";
import type { ChatMessageHit } from "../../data/types";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { dayLabel } from "./flow";
import { ChannelTag, ChatViewHeader, ExcerptLine } from "./ThreadsView";

// «Mentions» (shape chat.md §6): i messaggi che nominano chi guarda (lui,
// il suo reparto, @channel, una domanda), per giorno, con il canale. Il clic
// porta al messaggio evidenziato nel canale (o nel thread, se è una risposta).

function byDay(hits: ChatMessageHit[]): { day: string; hits: ChatMessageHit[] }[] {
  const out: { day: string; hits: ChatMessageHit[] }[] = [];
  for (const hit of hits) {
    const day = hit.message.createdAt.slice(0, 10);
    const last = out.at(-1);
    if (last?.day === day) last.hits.push(hit);
    else out.push({ day, hits: [hit] });
  }
  return out;
}

export function MentionsView() {
  const { t, i18n } = useTranslation();
  const me = useSessionPersonId();
  const mentions = useChatMentions();
  const rows = useChatChannels().data;
  const people = usePeople().data;
  const words = { today: t("chat.flow.today"), yesterday: t("chat.flow.yesterday") };
  return (
    <section className="flex min-h-full flex-col">
      <ChatViewHeader title={t("chat.views.mentionsTitle")} lede={t("chat.views.mentionsLede")} />
      <div className="max-w-[820px] px-4">
        {mentions.isError ? (
          <PageError
            message={t("chat.views.mentionsError")}
            onRetry={() => void mentions.refetch()}
          />
        ) : mentions.isPending ? (
          <PageSkeleton rows={4} />
        ) : mentions.data.length === 0 ? (
          <PageEmpty
            title={t("chat.views.mentionsEmpty")}
            body={t("chat.views.mentionsEmptyBody")}
          />
        ) : (
          byDay(mentions.data).map((group) => (
            <section key={group.day} aria-label={dayLabel(group.day, TODAY, i18n.language, words)}>
              <h2 className="heading-group px-4 pt-5 pb-1.5">
                {dayLabel(group.day, TODAY, i18n.language, words)}
              </h2>
              <ul className="flex flex-col">
                {group.hits.map((hit) => {
                  const m = hit.message;
                  return (
                    <li key={m.id} className="border-b border-rule last:border-b-0">
                      <Link
                        to="/chat/$channelId"
                        params={{ channelId: hit.channelId }}
                        search={
                          m.threadOf ? { thread: m.threadOf, message: m.id } : { message: m.id }
                        }
                        data-mention-row={m.id}
                        className="flex flex-col gap-1.5 rounded-md px-4 py-3 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <ChannelTag channelId={hit.channelId} rows={rows} me={me} people={people} />
                          {m.threadOf && (
                            <span className="shrink-0 text-xs text-ink-faint">
                              {t("chat.views.inThread")}
                            </span>
                          )}
                        </span>
                        <ExcerptLine message={m} people={people} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </section>
  );
}
