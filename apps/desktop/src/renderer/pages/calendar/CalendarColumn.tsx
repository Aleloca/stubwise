import { localDayKey } from "@stubwise/shared";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  calendarReadWindow,
  useCalendars,
  useGoogleAccount,
  useSessionPersonId,
  useSyncCalendar,
} from "../../data/queries";
import { now } from "../../data/dates";
import type { CalendarSyncView } from "../../data/types";
import { WorkingRing } from "../claude/conversation/parts";
import { openGoogleAccount } from "../drive/GoogleAccountCard";
import { AlertGlyph, ClockGlyph } from "../mail/glyphs";
import { dayLabel, minutesSince } from "../mail/format";
import { calendarSearch, resolveCalendar, windowDays, type CalendarSearch } from "./calendarParams";
import { MailboxSwatch } from "./EventBlock";
import { mailboxMarks } from "./gridLayout";
import { MiniMonth } from "./MiniMonth";
import { SeriesSidebar } from "./SeriesSidebar";

// La colonna del Calendario (shape calendar.md §3, §6), senza titolo: il
// mini-mese, CALENDARS con le caselle e il loro allineamento, RECURRING
// SERIES (chiusa di default). Il filtro per casella c'è solo con due o più
// caselle ed è ricordato per persona.

// --- filtro per casella, ricordato per persona ---------------------------------

const filterKey = (personId: string) => `stubwise.calendarHidden.${personId}`;
const listeners = new Set<() => void>();

function readHidden(personId: string): string {
  try {
    return window.localStorage.getItem(filterKey(personId)) ?? "[]";
  } catch {
    return "[]";
  }
}

/** Un valore rovinato nello storage vale «nessuna casella nascosta». */
function parseHidden(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Le caselle nascoste da chi guarda (vale solo con due o più caselle). */
export function useHiddenCalendars(): [Set<string>, (email: string, hidden: boolean) => void] {
  const personId = useSessionPersonId();
  const raw = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => readHidden(personId),
  );
  const hidden = new Set<string>(parseHidden(raw));
  const set = (email: string, hide: boolean) => {
    const next = new Set(hidden);
    if (hide) next.add(email);
    else next.delete(email);
    try {
      window.localStorage.setItem(filterKey(personId), JSON.stringify([...next]));
    } catch {
      // Senza storage il filtro vale finché la pagina resta aperta: niente da fare.
    }
    for (const l of listeners) l();
  };
  return [hidden, set];
}

// --- allineamento ------------------------------------------------------------------

export type CalendarSyncPhase = "expired" | "failed" | "syncing" | "stale" | "ok";

export function calendarSyncPhase(c: CalendarSyncView): CalendarSyncPhase {
  if (c.expired) return "expired";
  if (c.sync === "syncing") return "syncing";
  if (c.sync === "failed") return "failed";
  return c.stale ? "stale" : "ok";
}

function useUpdated() {
  const { t, i18n } = useTranslation();
  return (iso: string) => {
    const minutes = minutesSince(iso);
    if (minutes < 1) return t("calendar.sync.justNow");
    if (minutes < 60) return t("calendar.sync.minutes", { count: minutes });
    return t("calendar.sync.on", { date: dayLabel(iso, i18n.language) });
  };
}

const link =
  "rounded-sm font-medium underline decoration-ink/30 underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:decoration-ink";

/**
 * Lo stato di un calendario: «Updated 2 min ago» + «Refresh now» (bottone
 * icona); vecchio oltre 5 minuti in `warning`, con «Refresh now» a parole;
 * scaduto in `critical` con «Reconnect»; fallito con «Try again».
 */
export function CalendarSyncRow({
  calendar,
  inline = false,
}: {
  calendar: CalendarSyncView;
  inline?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const updated = useUpdated();
  const sync = useSyncCalendar();
  const account = useGoogleAccount().data;
  const since = account?.status === "expired" ? account.since : calendar.syncedAt;
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const requested = requestedAt !== null && requestedAt === calendar.syncedAt && !calendar.expired;
  const phase = requested ? "syncing" : calendarSyncPhase(calendar);
  const refresh = () => {
    setRequestedAt(calendar.syncedAt);
    sync.mutate(undefined, { onSettled: () => setRequestedAt(null) });
  };
  const base = `flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs ${inline ? "" : "pl-0"}`;
  if (phase === "expired") {
    return (
      <span data-calendar-sync="expired" className={`${base} text-critical`}>
        <AlertGlyph />
        <span>{t("calendar.sync.expired", { date: dayLabel(since, i18n.language) })}</span>
        <button type="button" className={`${link} text-ink`} onClick={() => openGoogleAccount()}>
          {t("calendar.sync.reconnect")}
        </button>
      </span>
    );
  }
  if (phase === "syncing") {
    return (
      <span data-calendar-sync="syncing" role="status" className={`${base} text-ink-muted`}>
        <WorkingRing size={10} />
        {t("calendar.sync.updating")}
      </span>
    );
  }
  if (phase === "failed") {
    return (
      <span data-calendar-sync="failed" className={`${base} text-critical`}>
        <AlertGlyph />
        {t("calendar.sync.failed")} ·
        <button type="button" className={`${link} text-ink`} onClick={refresh}>
          {t("calendar.sync.tryAgain")}
        </button>
      </span>
    );
  }
  if (phase === "stale") {
    return (
      <span data-calendar-sync="stale" className={`${base} text-warning`}>
        <ClockGlyph />
        {t("calendar.sync.behind", { updated: updated(calendar.syncedAt) })}
        <button type="button" className={`${link} text-ink`} onClick={refresh}>
          {t("calendar.sync.refreshNow")}
        </button>
      </span>
    );
  }
  return (
    <span data-calendar-sync="ok" className={`${base} text-ink-faint`}>
      {updated(calendar.syncedAt)}
      <button
        type="button"
        onClick={refresh}
        aria-label={t("calendar.sync.refreshNow")}
        title={t("calendar.sync.refreshNow")}
        className="grid size-5 place-items-center rounded-sm text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
      >
        <RefreshGlyph />
      </button>
    </span>
  );
}

function RefreshGlyph() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// --- la colonna -----------------------------------------------------------------------

export function CalendarColumn() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useRouterState({ select: (s) => s.location.search as CalendarSearch });
  const account = useGoogleAccount();
  const connected = !!account.data;
  const calendars = useCalendars();
  const [hidden, setHidden] = useHiddenCalendars();
  const win = windowDays(calendarReadWindow());
  const today = localDayKey(new Date(now()));
  const { view, anchor } = resolveCalendar(search, today, win);
  const calendarsId = useId();
  const list = connected ? (calendars.data ?? []) : [];
  const marks = mailboxMarks(list.map((c) => c.email));

  const pick = (day: string) =>
    void navigate({
      to: "/calendar",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...calendarSearch({ view, date: day }, today),
      }),
    } as never);

  return (
    <nav
      aria-label={t("column.viewsOf", { name: t("nav.calendar") })}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2"
    >
      <MiniMonth
        view={view}
        anchor={anchor}
        today={today}
        win={win}
        enabled={connected}
        onPick={pick}
      />
      {list.length > 0 && (
        <div className="mx-2 mt-1 border-t border-rule pt-3">
          <p id={calendarsId} className="heading-group px-2.5 pb-1.5">
            {t("calendar.column.calendars")}
          </p>
          <ul aria-labelledby={calendarsId} className="flex flex-col gap-1.5 px-2.5">
            {list.map((c) => {
              const mark = marks?.get(c.email);
              return (
                <li
                  key={c.email}
                  data-calendar-row={c.email}
                  className="flex min-w-0 flex-col gap-0.5"
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm text-ink">
                    {marks && (
                      <input
                        type="checkbox"
                        checked={!hidden.has(c.email)}
                        onChange={(e) => setHidden(c.email, !e.target.checked)}
                        aria-label={t("calendar.column.show", { email: c.email })}
                        className="size-3.5 shrink-0 accent-[var(--ink)]"
                      />
                    )}
                    {mark && <MailboxSwatch mark={mark} />}
                    <span title={c.email} className="min-w-0 truncate">
                      {c.email}
                    </span>
                  </span>
                  <CalendarSyncRow calendar={c} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {connected && <SeriesSidebar />}
    </nav>
  );
}
