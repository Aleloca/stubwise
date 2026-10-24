import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useChatChannels,
  useJoinChannel,
  usePeople,
  useProjects,
  useSessionPersonId,
} from "../../data/queries";
import type { ChannelRow } from "../../data/types";
import { inputClass } from "../../tasks-ui/Dialog";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { secondaryButton } from "../claude/conversation/parts";
import { rowLabel } from "./ChatPage";
import { useCanCreateChannel, useOpenChatDialog } from "./ChatColumn";
import { HashGlyph, LockGlyph } from "./glyphs";

// «Browse channels» (shape chat-manage.md §5): i canali che chi guarda vede,
// anche quelli in cui non è — gli aperti dei suoi progetti e dell'azienda,
// i privati di cui è membro o che gestisce (con «Not a member»), gli
// archiviati sotto il loro filtro. Mai un DM. Un privato non letto non
// mostra attività: solo nome, descrizione e membri.

const FILTERS = ["all", "project", "company", "archived"] as const;
type Filter = (typeof FILTERS)[number];

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

export function BrowseChannels() {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const channels = useChatChannels();
  const projects = useProjects().data;
  const people = usePeople().data;
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const canCreate = useCanCreateChannel();
  const openDialog = useOpenChatDialog();
  const searchId = useId();

  const rows = useMemo(() => {
    const needle = fold(q.trim());
    return (channels.data ?? [])
      .filter((r) => r.kind !== "dm")
      .filter((r) =>
        filter === "archived"
          ? r.archived
          : !r.archived &&
            (filter === "all" ||
              (filter === "project" ? r.kind === "project" : r.kind === "general")),
      )
      .map((r) => ({ row: r, name: rowLabel(r, me, projects, people) }))
      .filter(({ row, name }) => !needle || fold(`${name.label} ${row.description}`).includes(needle))
      .sort((a, b) => a.name.label.localeCompare(b.name.label));
  }, [channels.data, filter, q, me, projects, people]);

  return (
    <section className="flex min-h-full flex-col">
      <header className="page-header flex flex-col gap-3 border-b border-rule pb-4 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold text-ink">{t("chat.browse.title")}</h1>
          {canCreate && (
            <button type="button" className={secondaryButton} onClick={() => openDialog("newChannel")}>
              {t("chat.column.newChannel")}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div role="radiogroup" aria-label={t("chat.browse.filter")} className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                onClick={() => setFilter(f)}
                className={`inline-flex h-8 items-center rounded-md px-2.5 text-sm font-medium transition-colors duration-[var(--duration-fast)] ease-out ${
                  filter === f
                    ? "bg-ink/10 text-ink"
                    : "text-ink-muted hover:bg-ink/6 hover:text-ink"
                }`}
              >
                {t(`chat.browse.filters.${f}`)}
              </button>
            ))}
          </div>
          <label htmlFor={searchId} className="sr-only">
            {t("chat.browse.search")}
          </label>
          <input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("chat.browse.search")}
            className={`${inputClass} h-8 max-w-[280px] py-0`}
          />
        </div>
      </header>
      <div className="px-4">
        {channels.isError ? (
          <PageError message={t("chat.browse.error")} onRetry={() => void channels.refetch()} />
        ) : channels.isPending ? (
          <PageSkeleton rows={6} />
        ) : rows.length === 0 ? (
          <PageEmpty
            title={q.trim() ? t("chat.browse.noMatch") : t(`chat.browse.empty.${filter}`)}
          />
        ) : (
          <ul aria-label={t("chat.browse.title")} className="flex flex-col">
            {rows.map(({ row, name }) => (
              <BrowseRow key={row.id} row={row} label={name.label} code={name.code} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function BrowseRow({ row, label, code }: { row: ChannelRow; label: string; code: string | null }) {
  const { t } = useTranslation();
  const join = useJoinChannel();
  const toast = useToast();
  const navigate = useNavigate();
  const status = row.isMember
    ? t("chat.browse.joined")
    : row.visibility === "private"
      ? t("chat.browse.notMember")
      : null;
  return (
    <li
      data-browse-row={row.id}
      className="group relative flex min-h-11 min-w-0 items-center gap-3 border-b border-rule px-4 py-2 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
    >
      <span className="text-ink-faint">
        {row.visibility === "private" ? <LockGlyph /> : <HashGlyph />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <Link
          to="/chat/$channelId"
          params={{ channelId: row.id }}
          className="min-w-0 truncate text-md font-medium text-ink after:absolute after:inset-0 after:content-['']"
          title={label}
        >
          {code && (
            <span className="num text-ink-muted">
              {code}
              {row.kind === "project" ? " · " : " "}
            </span>
          )}
          {row.name}
        </Link>
        {row.description && (
          <span className="min-w-0 truncate text-sm text-ink-muted">{row.description}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-3 text-sm text-ink-muted">
        {row.visibility === "private" && <span>{t("chat.channel.private")}</span>}
        {row.archived && <span>{t("chat.channel.archived")}</span>}
        <span className="num max-[1180px]:hidden">
          {t("chat.channel.members", { count: row.memberIds.length })}
        </span>
        {row.canJoin ? (
          <button
            type="button"
            className={`${secondaryButton} relative z-10`}
            disabled={join.isPending}
            onClick={() =>
              join.mutate(row.id, {
                onSuccess: () =>
                  void navigate({ to: "/chat/$channelId", params: { channelId: row.id } }),
                onError: () => toast.error(t("chat.channel.joinFailed")),
              })
            }
          >
            {t("chat.channel.join")}
          </button>
        ) : (
          status && <span className="text-ink-faint">{status}</span>
        )}
      </span>
    </li>
  );
}
