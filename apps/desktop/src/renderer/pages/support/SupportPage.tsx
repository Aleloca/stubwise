import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  usePeople,
  useProject,
  useSessionPersonId,
  useSupportConversations,
  useSupportWidgets,
} from "../../data/queries";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { primaryButton } from "../claude/conversation/parts";
import { ConversationDetail } from "./ConversationDetail";
import { ConversationList, type ChannelFilter } from "./ConversationList";
import { SUPPORT_TWO_UP_QUERY } from "./format";
import { Widgets } from "./Widgets";

// La sezione Support di un progetto (shape support.md §3, `#/p/ACQ/support`):
// uno sportello a protocollo, gemello della Posta — elenco per stato a
// sinistra (380 px), la conversazione aperta a destra
// (`#/p/ACQ/support/ACQ-S2`). Per chi ha `widget.manage` la seconda vista
// «Widgets» (`?view=widgets`, [A 1]). Sotto ~1100 px elenco e dettaglio uno
// per volta. Cambiare persona rimonta la pagina (chiave nel router).

const NO_FILTERS: { query: string; channel: ChannelFilter } = { query: "", channel: "any" };
const FILTERS = new Map<string, typeof NO_FILTERS>();

/** Una conversazione che non esiste, o di un progetto che non si vede: la stessa pagina (R-G5). */
export function ConversationNotFound() {
  const { t } = useTranslation();
  return (
    <section className="page-header flex flex-col items-start gap-2 pb-8 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <h1 className="text-2xl font-semibold text-ink">{t("support.notFound")}</h1>
      <Link to="/home" className="text-md text-ink underline underline-offset-4">
        {t("project.backHome")}
      </Link>
    </section>
  );
}

function ViewSwitch({
  projectCode,
  current,
  widgets,
}: {
  projectCode: string;
  current: "conversations" | "widgets";
  widgets: number;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const go = (view: "conversations" | "widgets") =>
    void navigate({
      to: "/p/$code/$section",
      params: { code: projectCode, section: "support" },
      search: (view === "widgets" ? { view: "widgets" } : {}) as never,
    });
  // Gettoni, non link: la vista corrente si decide qui (anche col dettaglio
  // di una conversazione aperto, che è un'altra route).
  const token =
    "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-pressed:bg-ink/10 aria-pressed:text-ink";
  return (
    <div
      role="group"
      aria-label={t("support.views.label")}
      className="flex items-center gap-1 text-ink-muted"
    >
      <button
        type="button"
        aria-pressed={current === "conversations"}
        onClick={() => go("conversations")}
        className={token}
      >
        {t("support.views.conversations")}
      </button>
      <button
        type="button"
        aria-pressed={current === "widgets"}
        onClick={() => go("widgets")}
        className={token}
      >
        {t("support.views.widgets")}
        <span className="num text-ink-faint">{widgets}</span>
      </button>
    </div>
  );
}

export function SupportPage({
  projectCode,
  conversationCode,
}: {
  projectCode: string;
  conversationCode?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useSessionPersonId();
  const search = useSearch({ strict: false }) as { view?: string; widget?: string };
  const project = useProject(projectCode).data ?? undefined;
  const list = useSupportConversations(project?.id);
  const widgets = useSupportWidgets(project?.id);
  const people = usePeople().data;
  const twoUp = useMediaQuery(SUPPORT_TWO_UP_QUERY);
  // La ricerca e il canale restano aprendo una conversazione (è un'altra
  // route: la pagina si rimonta), per persona e progetto.
  const filterKey = `${me}:${projectCode}`;
  const [filters, setFilters] = useState(() => FILTERS.get(filterKey) ?? NO_FILTERS);
  const setFilter = (patch: Partial<typeof NO_FILTERS>) =>
    setFilters((old) => {
      const next = { ...old, ...patch };
      FILTERS.set(filterKey, next);
      return next;
    });
  const { query, channel } = filters;
  const setQuery = (q: string) => setFilter({ query: q });
  const setChannel = (c: ChannelFilter) => setFilter({ channel: c });

  const canManage = widgets.data?.canManage ?? false;
  const view = search.view === "widgets" && canManage ? "widgets" : "conversations";
  const personName = (id: string | null) => people?.find((p) => p.id === id)?.name ?? null;

  const open = (code: string, how: "click" | "keys") =>
    void navigate({
      to: "/p/$code/support/$conversation",
      params: { code: projectCode, conversation: code },
      replace: how === "keys",
    });

  const empty = (
    <PageEmpty
      title={t("support.empty.title")}
      body={canManage ? t("support.empty.manage") : t("support.empty.others")}
      action={
        canManage ? (
          <Link
            to="/p/$code/$section"
            params={{ code: projectCode, section: "support" }}
            search={{ view: "widgets", widget: "new" } as never}
            className={primaryButton}
          >
            {t("support.empty.setUp")}
          </Link>
        ) : undefined
      }
    />
  );

  const listPane = list.isError ? (
    <PageError message={t("support.list.error")} onRetry={() => void list.refetch()} />
  ) : !list.data ? (
    <PageSkeleton rows={6} />
  ) : (
    <ConversationList
      conversations={list.data}
      me={me}
      selectedCode={conversationCode ?? null}
      query={query}
      setQuery={setQuery}
      channel={channel}
      setChannel={setChannel}
      onOpen={open}
      personName={personName}
      empty={empty}
    />
  );

  const back = !twoUp && (
    <Link
      to="/p/$code/$section"
      params={{ code: projectCode, section: "support" }}
      className="self-start rounded-sm text-sm text-ink-muted underline-offset-4 hover:text-ink hover:underline"
    >
      ← {t("support.list.back")}
    </Link>
  );

  const detail = conversationCode ? (
    <ConversationDetail
      key={conversationCode}
      code={conversationCode}
      back={back || undefined}
      notFound={<ConversationNotFound />}
    />
  ) : (
    <div className="flex min-w-0 flex-1 items-center justify-center px-8">
      <p className="text-md text-ink-faint">{t("support.list.select")}</p>
    </div>
  );

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="page-header flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-rule pb-4 pl-8 [--page-header-pr:32px] [--page-header-pt:28px]">
        <h1 className="text-2xl font-semibold text-ink">{t("support.title")}</h1>
        {canManage && (
          <ViewSwitch
            projectCode={projectCode}
            current={view}
            widgets={widgets.data?.widgets.length ?? 0}
          />
        )}
      </header>
      {view === "widgets" && project ? (
        <Widgets projectId={project.id} projectCode={projectCode} open={search.widget ?? null} />
      ) : twoUp ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[380px] shrink-0 flex-col border-r border-rule">{listPane}</div>
          {detail}
        </div>
      ) : conversationCode ? (
        <div className="flex min-h-0 flex-1">{detail}</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">{listPane}</div>
      )}
    </section>
  );
}
