import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useChatChannels,
  useThreadsWithNews,
  useMarkChannelRead,
  usePeople,
  usePinnedProjects,
  useProjects,
  useSessionPersonId,
} from "../../data/queries";
import type { ChannelRow, Person } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { ONE_LINE, columnItemClass } from "../../layout/ProjectColumn";
import { hasModKey, shortcutLabel } from "../../platform/platform";
import { typing } from "../tasks/useTaskKeys";
import {
  chatColumnModel,
  columnOrder,
  groupOpenOf,
  hasNews,
  rememberGroupOpen,
  type ProjectGroup,
} from "./column";
import { ColumnSearchField } from "./ChatSearch";
import { useHasDraft } from "./drafts";
import {
  ComposeGlyph,
  DisclosureGlyph,
  DraftGlyph,
  HashGlyph,
  LockGlyph,
  MutedGlyph,
  PlusGlyph,
} from "./glyphs";
import { ChatAvatar } from "./MessageItem";

// La colonna della Chat (shape chat.md §3): «New message», Threads e
// Mentions con il conteggio, i canali per progetto (fissati prima, poi per
// codice; un gruppo senza nulla di nuovo è chiuso, e si ricorda aperto o
// chiuso per persona), i generali dell'azienda, «Browse channels», i
// messaggi diretti. Non letto = peso, menzione = numero in pastiglia
// d'inchiostro, silenziato = tenue con la campanella barrata, bozza =
// matita. La sezione Chat del progetto usa le stesse righe (`ChannelLink`).

/** Dove si apre un canale: la Chat o la sezione Chat del progetto. */
export type ChannelTo = { to: "/chat/$channelId"; params: { channelId: string } } | {
  to: "/p/$code/chat/$channelId";
  params: { code: string; channelId: string };
};

export const chatTo = (channelId: string): ChannelTo => ({
  to: "/chat/$channelId",
  params: { channelId },
});

export const projectChatTo = (code: string, channelId: string): ChannelTo => ({
  to: "/p/$code/chat/$channelId",
  params: { code, channelId },
});

/** Il canale aperto dall'indirizzo (`/chat/<id>` o `/p/<CODE>/chat/<id>`), se c'è. */
export function channelIdOf(pathname: string): string | undefined {
  return /^\/(?:chat|p\/[^/]+\/chat)\/([^/]+)$/.exec(pathname)?.[1];
}

/** Apre un dialogo della Chat sopra la pagina (`?newMessage=1`, `?newChannel=…`). */
export function useOpenChatDialog() {
  const navigate = useNavigate();
  return (key: "newMessage" | "newChannel", value = "1") =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, [key]: value }),
    } as never);
}

/** Chi guarda può creare almeno un canale (di progetto o generale): c'è il «+». */
export function useCanCreateChannel(): boolean {
  const { viewer } = useViewer();
  return can(viewer, "chat.general.create") || can(viewer, "chat.channels.create");
}

/** Il nome di un DM nella colonna: gli altri, al più due nomi poi «+N». */
export function dmName(
  row: Pick<ChannelRow, "memberIds">,
  me: string,
  people: Person[] | undefined,
): { short: string; full: string; first: Person | undefined } {
  const others = row.memberIds
    .filter((id) => id !== me)
    .map((id) => people?.find((p) => p.id === id));
  const names = others.map((p) => p?.name ?? "");
  const short =
    names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ");
  return { short, full: names.join(", "), first: others[0] };
}

/**
 * Una riga canale (o DM) della colonna. I conteggi stanno anche nel nome
 * accessibile («general, 3 unread, 1 mention»): il colore non è mai l'unico
 * segnale.
 */
export function ChannelLink({
  row,
  to,
  people,
  nested = false,
}: {
  row: ChannelRow;
  to: ChannelTo;
  people?: Person[] | undefined;
  /** Rientrata sotto la riga del progetto (28px). */
  nested?: boolean;
}) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const draft = useHasDraft(me, row.id);
  const muted = row.notifyLevel === "muted";
  const unread = !muted && row.unread > 0;
  const dm = row.kind === "dm" ? dmName(row, me, people) : null;
  const name = dm ? dm.full : row.name;
  const parts = [
    name,
    row.visibility === "private" && !dm ? t("chat.column.private") : null,
    muted ? t("chat.column.muted") : null,
    row.unread > 0 ? t("chat.column.unread", { count: row.unread }) : null,
    row.mentions > 0 ? t("chat.column.mentions", { count: row.mentions }) : null,
    draft ? t("chat.column.draft") : null,
  ].filter(Boolean);
  return (
    <Link
      {...to}
      aria-label={parts.join(", ")}
      title={name}
      data-channel-row={row.id}
      data-unread={unread || undefined}
      style={{ whiteSpace: "nowrap" }}
      className={`${columnItemClass} ${nested ? "h-7 pl-7" : ""} ${
        unread ? "font-semibold text-ink" : muted ? "text-ink-faint" : ""
      }`}
    >
      {dm ? (
        <ChatAvatar person={dm.first} size={20} />
      ) : (
        <span className="text-ink-faint">
          {row.visibility === "private" ? <LockGlyph size={13} /> : <HashGlyph size={13} />}
        </span>
      )}
      <span style={ONE_LINE} className="min-w-0 flex-1">
        {dm ? dm.short : row.name}
      </span>
      {muted && (
        <span className="text-ink-faint">
          <MutedGlyph />
        </span>
      )}
      {row.mentions > 0 ? (
        <MentionPill count={row.mentions} />
      ) : draft ? (
        <span className="text-ink-muted">
          <DraftGlyph />
        </span>
      ) : null}
    </Link>
  );
}

/** Il segnale «ti aspetta» della colonna: numero in pastiglia piena d'inchiostro, mai rossa. */
export function MentionPill({ count }: { count: number }) {
  return (
    <span
      aria-hidden="true"
      data-mention-pill
      className="num grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-ink px-1.5 text-xs font-semibold text-ground"
    >
      {count}
    </span>
  );
}

/** Un conteggio tenue a destra di una voce (Threads, Mentions). */
function Count({ value }: { value: number }) {
  if (value === 0) return null;
  return (
    <span aria-hidden="true" className="num ml-auto shrink-0 text-xs text-ink-faint">
      {value}
    </span>
  );
}

/**
 * La tastiera della Chat, dove c'è la sua colonna (destinazione o sezione
 * del progetto): ⌥↑/⌥↓ canale precedente/successivo, ⌥⇧↑/⌥⇧↓ non letto
 * precedente/successivo, Maiusc+Esc segna tutto letto. Mai mentre si
 * scrive (casella, campi, ricerche): lì ⌥↑/⌥↓ muovono il cursore e Maiusc+Esc
 * non deve segnare letto nulla. ⌘N (nuovo messaggio) è globale (`useShortcuts`).
 */
export function useChatKeys(order: readonly ChannelRow[], hrefOf: (row: ChannelRow) => ChannelTo) {
  const navigate = useNavigate();
  const markRead = useMarkChannelRead();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = channelIdOf(pathname);
  const latest = useRef({ order, hrefOf, current, markRead, navigate });
  latest.current = { order, hrefOf, current, markRead, navigate };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      // Un dialogo aperto (palette, nuovo canale…) tiene i suoi tasti.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (typing(e.target)) return;
      const { order, hrefOf, current, markRead, navigate } = latest.current;
      if (e.key === "Escape" && e.shiftKey && !e.altKey && !hasModKey(e)) {
        // Tutto letto: anche un silenziato con una menzione diretta.
        for (const row of order) {
          if (row.unread > 0 || row.mentions > 0) markRead.mutate({ channelId: row.id });
        }
        return;
      }
      if (!e.altKey || hasModKey(e) || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      const pool = e.shiftKey ? order.filter((r) => hasNews(r) || r.id === current) : order;
      if (pool.length === 0) return;
      const at = pool.findIndex((r) => r.id === current);
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next =
        at < 0 ? pool[step > 0 ? 0 : pool.length - 1] : pool[(at + step + pool.length) % pool.length];
      if (!next || next.id === current) return;
      e.preventDefault();
      void navigate(hrefOf(next) as never);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function ChatColumn() {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const channels = useChatChannels();
  const projects = useProjects().data;
  const pinned = usePinnedProjects().data;
  const people = usePeople().data;
  const threads = useThreadsWithNews().data;
  const openDialog = useOpenChatDialog();
  const canCreate = useCanCreateChannel();
  const view = useRouterState({
    select: (s) =>
      s.location.pathname === "/chat" ? (s.location.search as { view?: string }).view : undefined,
  });
  const current = useRouterState({ select: (s) => channelIdOf(s.location.pathname) });

  const model = useMemo(
    () =>
      chatColumnModel(
        channels.data ?? [],
        projects ?? [],
        (pinned ?? []).map((p) => p.id),
      ),
    [channels.data, projects, pinned],
  );
  const order = useMemo(() => columnOrder(model), [model]);
  useChatKeys(order, (row) => chatTo(row.id));

  const mentions = (channels.data ?? [])
    .filter((r) => r.isMember && r.kind !== "dm")
    .reduce((n, r) => n + r.mentions, 0);
  const channelsId = useId();
  const dmsId = useId();
  const loading = channels.isPending || !projects;

  return (
    <nav
      aria-label={t("column.viewsOf", { name: t("nav.chat") })}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-3 pb-2"
    >
      <button
        type="button"
        onClick={() => openDialog("newMessage")}
        className="flex h-8 w-full shrink-0 items-center gap-2 rounded-md border border-rule-strong px-2.5 text-md font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 active:bg-ink/10"
      >
        <ComposeGlyph />
        <span className="min-w-0 flex-1 truncate text-left">{t("chat.column.newMessage")}</span>
        <kbd className="num shrink-0 font-sans text-xs text-ink-faint">
          {shortcutLabel(["mod", "N"])}
        </kbd>
      </button>
      <ColumnSearchField />
      <ul className="mt-2 flex flex-col gap-px">
        <li>
          <Link
            to="/chat"
            search={{ view: "threads" }}
            aria-current={view === "threads" ? "page" : undefined}
            activeOptions={{ exact: true, includeSearch: true }}
            aria-label={
              threads?.length
                ? `${t("chat.column.threads")}, ${t("chat.column.threadsNew", { count: threads.length })}`
                : t("chat.column.threads")
            }
            className={columnItemClass}
          >
            <span style={ONE_LINE} className="min-w-0">
              {t("chat.column.threads")}
            </span>
            <Count value={threads?.length ?? 0} />
          </Link>
        </li>
        <li>
          <Link
            to="/chat"
            search={{ view: "mentions" }}
            aria-current={view === "mentions" ? "page" : undefined}
            activeOptions={{ exact: true, includeSearch: true }}
            aria-label={
              mentions
                ? `${t("chat.column.mentionsView")}, ${t("chat.column.mentions", { count: mentions })}`
                : t("chat.column.mentionsView")
            }
            className={columnItemClass}
          >
            <span style={ONE_LINE} className="min-w-0">
              {t("chat.column.mentionsView")}
            </span>
            <Count value={mentions} />
          </Link>
        </li>
      </ul>

      <div className="mt-3 border-t border-rule pt-3">
        <div className="flex items-center justify-between pr-1 pl-2.5">
          <p id={channelsId} className="heading-group py-1.5">
            {t("chat.column.channels")}
          </p>
          {canCreate && (
            <button
              type="button"
              aria-label={t("chat.column.newChannel")}
              title={t("chat.column.newChannel")}
              onClick={() => openDialog("newChannel")}
              className="grid size-6 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink"
            >
              <PlusGlyph />
            </button>
          )}
        </div>
        {loading ? (
          <ColumnSkeleton />
        ) : model.projects.length + model.quiet.length === 0 && model.company.length === 0 ? (
          <p className="px-2.5 py-1.5 text-sm text-ink-muted">
            {t("chat.column.empty")}{" "}
            <Link
              to="/chat"
              search={{ view: "browse" }}
              className="font-medium text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
            >
              {t("chat.column.browse")}
            </Link>
          </p>
        ) : (
          <ul aria-labelledby={channelsId} className="flex flex-col gap-px">
            {model.projects.map((group) => (
              <ProjectGroupItem
                // Per persona: cambiando «vedi come» ogni gruppo rilegge la sua scelta.
                key={`${me}:${group.project.id}`}
                group={group}
                me={me}
                people={people}
                current={current}
              />
            ))}
            {model.quiet.length > 0 && (
              <OtherProjects
                key={`${me}:others`}
                groups={model.quiet}
                me={me}
                people={people}
                current={current}
              />
            )}
            {model.company.length > 0 && (
              <li>
                <p className="flex h-7 items-center px-2.5 text-sm font-semibold text-ink-muted">
                  {t("chat.column.company")}
                </p>
                <ul aria-label={t("chat.column.company")} className="flex flex-col gap-px">
                  {model.company.map((row) => (
                    <li key={row.id}>
                      <ChannelLink row={row} to={chatTo(row.id)} people={people} nested />
                    </li>
                  ))}
                </ul>
              </li>
            )}
          </ul>
        )}
        <Link
          to="/chat"
          search={{ view: "browse" }}
          aria-current={view === "browse" ? "page" : undefined}
          activeOptions={{ exact: true, includeSearch: true }}
          className={`${columnItemClass} mt-1`}
        >
          <span style={ONE_LINE} className="min-w-0">
            {t("chat.column.browse")}
          </span>
        </Link>
      </div>

      <div className="mt-3 border-t border-rule pt-3">
        <div className="flex items-center justify-between pr-1 pl-2.5">
          <p id={dmsId} className="heading-group py-1.5">
            {t("chat.column.direct")}
          </p>
          <button
            type="button"
            aria-label={t("chat.column.newMessage")}
            title={t("chat.column.newMessage")}
            onClick={() => openDialog("newMessage")}
            className="grid size-6 place-items-center rounded-md text-ink-muted hover:bg-ink/6 hover:text-ink"
          >
            <PlusGlyph />
          </button>
        </div>
        {!loading && model.dms.length === 0 ? (
          <p className="px-2.5 py-1.5 text-sm text-ink-muted">{t("chat.column.noDms")}</p>
        ) : (
          <ul aria-labelledby={dmsId} className="flex flex-col gap-px">
            {model.dms.map((row) => (
              <li key={row.id}>
                <ChannelLink row={row} to={chatTo(row.id)} people={people} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

/**
 * Il sottogruppo di un progetto: la riga (codice 600 + nome muted, freccia)
 * apre e chiude. Chiuso di default se non c'è nulla di non letto; la scelta
 * a mano si ricorda per persona. Il canale aperto apre il suo gruppo (finché non lo si chiude).
 * Chiuso, la riga dice cosa c'è sotto: punto pieno per le menzioni,
 * grassetto per i soli non letti.
 */
function ProjectGroupItem({
  group,
  me,
  people,
  current,
}: {
  group: ProjectGroup;
  me: string;
  people: Person[] | undefined;
  current: string | undefined;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const openDialog = useOpenChatDialog();
  const { project } = group;
  const news = group.channels.some(hasNews);
  const canCreate = can(viewer, "chat.channels.create", project.id);
  const [chosen, setChosen] = useState<boolean | undefined>(() => groupOpenOf(me, project.id));
  const holdsCurrent = group.channels.some((c) => c.id === current);
  const open = chosen ?? (news || holdsCurrent);
  const listId = useId();
  const unread = group.channels.some((c) => c.unread > 0 && c.notifyLevel !== "muted");
  const label = [
    `${project.code} ${project.name}`,
    !open && group.mentions > 0 ? t("chat.column.mentions", { count: group.mentions }) : null,
    !open && group.mentions === 0 && unread ? t("chat.column.hasUnread") : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <li data-project-group={project.code} className="group/project relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={label}
        title={`${project.code} ${project.name}`}
        onClick={() => {
          const next = !open;
          setChosen(next);
          rememberGroupOpen(me, project.id, next);
        }}
        className={`flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2.5 text-left text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 ${canCreate ? "pr-8" : ""}`}
      >
        <DisclosureGlyph open={open} />
        <span
          className={`num shrink-0 font-semibold ${!open && unread ? "text-ink" : "text-ink-muted"}`}
        >
          {project.code}
        </span>
        <span
          style={ONE_LINE}
          className={`min-w-0 flex-1 ${!open && unread ? "font-semibold text-ink" : "text-ink-muted"}`}
        >
          {project.name}
        </span>
        {!open && group.mentions > 0 && (
          <span
            aria-hidden="true"
            data-group-dot
            className="size-2 shrink-0 rounded-full bg-ink"
          />
        )}
      </button>
      {canCreate && (
        // «New channel» del progetto, già scelto (shape chat-manage.md §3).
        <button
          type="button"
          aria-label={t("chat.column.newChannelIn", { code: project.code })}
          title={t("chat.column.newChannelIn", { code: project.code })}
          onClick={() => openDialog("newChannel", project.code)}
          className="absolute top-0.5 right-1 grid size-6 place-items-center rounded-md text-ink-muted opacity-0 transition-opacity duration-[var(--duration-fast)] ease-out group-hover/project:opacity-100 hover:bg-ink/6 hover:text-ink focus-visible:opacity-100"
        >
          <PlusGlyph size={12} />
        </button>
      )}
      {open && (
        <ul id={listId} className="flex flex-col gap-px">
          {group.channels.map((row) => (
            <li key={row.id}>
              <ChannelLink row={row} to={chatTo(row.id)} people={people} nested />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** La chiave con cui la colonna ricorda «Other projects» aperta o chiusa. */
const OTHERS = "others";

/**
 * I progetti né fissati né con qualcosa di nuovo, in una riga chiusa
 * «Other projects · N» (approvata dal maintainer il 24 ott 2026): la
 * colonna resta corta e i messaggi diretti sopra la piega. Si apre a mano
 * (e se lo ricorda per persona) o da sola sul canale aperto che ci sta
 * dentro; un progetto che riceve qualcosa di nuovo ne esce da sé.
 */
function OtherProjects({
  groups,
  me,
  people,
  current,
}: {
  groups: ProjectGroup[];
  me: string;
  people: Person[] | undefined;
  current: string | undefined;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<boolean | undefined>(() => groupOpenOf(me, OTHERS));
  const holdsCurrent = groups.some((g) => g.channels.some((c) => c.id === current));
  const open = chosen ?? holdsCurrent;
  const listId = useId();
  return (
    <li data-other-projects>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setChosen(!open);
          rememberGroupOpen(me, OTHERS, !open);
        }}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2.5 text-left text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
      >
        <DisclosureGlyph open={open} />
        <span style={ONE_LINE} className="min-w-0 flex-1">
          {t("chat.column.otherProjects", { count: groups.length })}
        </span>
      </button>
      {open && (
        <ul id={listId} className="flex flex-col gap-px">
          {groups.map((group) => (
            <ProjectGroupItem
              key={`${me}:${group.project.id}`}
              group={group}
              me={me}
              people={people}
              current={current}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function ColumnSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="skeleton-breathe flex flex-col gap-2 px-2.5 py-1.5">
      <span role="status" className="sr-only">
        {t("chat.column.loading")}
      </span>
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className="h-3 rounded bg-ink/8" style={{ width: `${45 + ((i * 23) % 40)}%` }} />
      ))}
    </div>
  );
}
