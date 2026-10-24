import { Link, Navigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  useChatChannels,
  usePeople,
  usePinnedProjects,
  useProjects,
  useSessionPersonId,
} from "../../data/queries";
import type { ChannelRow, Person, Project } from "../../data/types";
import { PageEmpty } from "../../tasks-ui/PageStates";
import { BrowseChannels } from "./BrowseChannels";
import { dmName } from "./ChatColumn";
import { chatColumnModel, columnOrder, lastChannelOf } from "./column";
import { ChatSearch } from "./ChatSearch";
import { MentionsView } from "./MentionsView";
import { ThreadsView } from "./ThreadsView";

// `#/chat`: con `?view=` le viste della colonna (Threads, Mentions, Browse
// channels, la ricerca); senza, l'atterraggio — l'ultimo canale aperto dalla persona,
// la prima volta il «general» del primo progetto fissato (shape chat.md §6).

/** Il nome di un canale in un elenco: «AUD · general», «# announcements», i nomi del DM. */
export function rowLabel(
  row: Pick<ChannelRow, "kind" | "name" | "projectId" | "memberIds">,
  me: string,
  projects: Project[] | undefined,
  people: Person[] | undefined,
): { code: string | null; name: string; label: string } {
  if (row.kind === "project") {
    const code = projects?.find((p) => p.id === row.projectId)?.code ?? "";
    return { code, name: row.name, label: `${code} · ${row.name}` };
  }
  if (row.kind === "general") return { code: "#", name: row.name, label: `# ${row.name}` };
  const names = dmName(row, me, people).full;
  return { code: null, name: names, label: names };
}

/**
 * Il canale dove atterrare: l'ultimo aperto, se c'è ancora; se no il
 * «general» del primo progetto fissato in cui si è, poi il primo «general»
 * della colonna, poi il primo canale.
 */
export function landingChannel(
  rows: readonly ChannelRow[],
  projects: readonly Project[],
  pinnedIds: readonly string[],
  last: string | null,
): ChannelRow | undefined {
  const order = columnOrder(chatColumnModel(rows, projects, pinnedIds));
  const remembered = last ? rows.find((r) => r.id === last && !r.archived) : undefined;
  if (remembered) return remembered;
  // Il primo progetto fissato di cui si è membri (il «general» segue i membri del progetto).
  for (const id of pinnedIds) {
    const general = order.find((r) => r.isGeneral && r.projectId === id);
    if (general) return general;
  }
  return order.find((r) => r.isGeneral) ?? order[0];
}

export function ChatPage() {
  const viewer = useSessionPersonId();
  const search = useSearch({ strict: false }) as { view?: string };
  if (search.view === "threads") return <ThreadsView key={viewer} />;
  if (search.view === "mentions") return <MentionsView key={viewer} />;
  if (search.view === "browse") return <BrowseChannels key={viewer} />;
  // La ricerca si svuota da sé al cambio di persona (query compresa).
  if (search.view === "search") return <ChatSearch />;
  return <ChatLanding key={viewer} />;
}

function ChatLanding() {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const channels = useChatChannels();
  const projects = useProjects().data;
  const pinned = usePinnedProjects().data;
  usePeople();
  if (channels.data && projects && pinned) {
    const target = landingChannel(
      channels.data,
      projects,
      pinned.map((p) => p.id),
      lastChannelOf(me),
    );
    if (target) {
      return <Navigate to="/chat/$channelId" params={{ channelId: target.id }} replace />;
    }
    return (
      <section className="page-header flex flex-col pb-8 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <h1 className="text-2xl font-semibold text-ink">{t("nav.chat")}</h1>
        <div className="-ml-4">
          <PageEmpty
            title={t("chat.landing.emptyTitle")}
            body={t("chat.landing.emptyBody")}
            action={
              <Link
                to="/chat"
                search={{ view: "browse" }}
                className="inline-flex h-8 items-center rounded-md border border-rule-strong px-3 text-sm font-medium text-ink hover:bg-ink/6"
              >
                {t("chat.column.browse")}
              </Link>
            }
          />
        </div>
      </section>
    );
  }
  return (
    <section aria-busy="true" className="flex flex-col gap-2 p-8">
      <h1 className="sr-only">{t("nav.chat")}</h1>
      <span role="status" className="text-sm text-ink-muted">
        {t("chat.channel.loading")}
      </span>
    </section>
  );
}
