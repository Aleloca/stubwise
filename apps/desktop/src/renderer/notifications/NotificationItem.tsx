import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AppNotification, Project } from "../data/types";
import { DeptStrip, useDeptLabel } from "../layout/DeptStrip";
import {
  SNOOZE_OPTIONS,
  formatDateTime,
  relativeTime,
  snoozeTarget,
  tabOf,
  type SnoozeOption,
} from "./time";

export type Change = { read?: boolean; archived?: boolean; snoozedUntil?: string | null };

const actionClass =
  "rounded-md px-2 py-1 text-xs font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:bg-ink/10";

interface Props {
  notification: AppNotification;
  project: Pick<Project, "code" | "name"> | undefined;
  onOpen: () => void;
  onChange: (change: Change) => void;
}

/**
 * Una notifica: il codice del suo OGGETTO in testa (task, progetto o evento),
 * il progetto (o la provenienza) accanto, titolo, fino a due righe di testo,
 * quando. Se l'oggetto è una task, la striscia del suo reparto. Non letta =
 * titolo in grassetto + punto d'inchiostro (più un testo per i lettori di
 * schermo): il colore da solo non basta. Le azioni si sovrappongono al
 * passaggio o al fuoco, senza riservare spazio, e restano raggiungibili da
 * tastiera. Solo informazioni: nessuna decisione si prende da qui.
 */
export function NotificationItem({ notification: n, project, onOpen, onChange }: Props) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const deptLabel = useDeptLabel(n.departmentId);
  const tab = tabOf(n);
  const when =
    tab === "snoozed" && n.snoozedUntil
      ? t("notifications.until", { when: formatDateTime(n.snoozedUntil, i18n.language) })
      : relativeTime(n.createdAt, t, i18n.language);

  function onMenuKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      // Chiude solo il menu, non il pannello (preventDefault: il listener
      // del documento la vede come già consumata).
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
    }
  }

  // Testo secondario: il progetto; senza progetto, la provenienza dell'evento.
  const prefix = n.objectCode.split("-")[0];
  const secondary =
    project?.name ??
    (prefix && i18n.exists(`notifications.sources.${prefix}`)
      ? t(`notifications.sources.${prefix}`)
      : undefined);

  const choose = (option: SnoozeOption) => {
    setMenuOpen(false);
    onChange({ snoozedUntil: snoozeTarget(option) });
  };

  return (
    <li
      data-notification={n.id}
      className="group relative border-b border-rule transition-colors duration-[var(--duration-fast)] ease-out focus-within:bg-ink/4 hover:bg-ink/4"
    >
      <button
        type="button"
        onClick={onOpen}
        title={deptLabel}
        className="relative flex w-full items-start gap-3 px-4 py-2.5 text-left"
      >
        <span aria-hidden="true" className="mt-1.5 grid size-2 shrink-0 place-items-center">
          {!n.read && <span data-unread-dot className="size-2 rounded-full bg-ink" />}
        </span>
        {!n.read && <span className="sr-only">{t("notifications.unread")}</span>}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span data-object-code className="num shrink-0 text-sm font-semibold text-ink">
              {n.objectCode}
            </span>
            {secondary && (
              <span className="min-w-0 truncate text-xs text-ink-muted">{secondary}</span>
            )}
            <span className="ml-auto shrink-0 text-xs text-ink-muted">{when}</span>
          </span>
          <span
            className={`mt-0.5 block text-md text-ink ${n.read ? "font-normal" : "font-semibold"}`}
          >
            {n.title}
          </span>
          <span className="line-clamp-2 text-sm text-ink-muted">{n.body}</span>
        </span>
        <DeptStrip departmentId={n.departmentId} />
      </button>

      {/* Le azioni non riservano spazio: si sovrappongono all'angolo in alto a
          destra (sopra il «quando») al passaggio o al fuoco, e restano
          raggiungibili da tastiera. */}
      <div
        data-notification-actions
        className={`absolute top-2 right-3 flex items-center gap-1 bg-[color-mix(in_oklch,var(--ink)_4%,var(--surface))] pl-2 group-focus-within:opacity-100 group-hover:opacity-100 ${menuOpen ? "opacity-100" : "opacity-0"}`}
      >
        {!n.read && (
          <button type="button" className={actionClass} onClick={() => onChange({ read: true })}>
            {t("notifications.actions.markRead")}
          </button>
        )}
        {tab === "new" && (
          <button
            type="button"
            className={actionClass}
            onClick={() => onChange({ archived: true })}
          >
            {t("notifications.actions.archive")}
          </button>
        )}
        {tab === "new" && (
          <div className="relative" onKeyDown={onMenuKeyDown}>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={actionClass}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {t("notifications.actions.snooze")}
            </button>
            {menuOpen && (
              <div
                role="menu"
                aria-label={t("notifications.actions.snooze")}
                className="absolute top-full right-0 z-10 mt-1 flex min-w-36 flex-col rounded-lg border border-rule-strong bg-surface p-1"
              >
                {SNOOZE_OPTIONS.map((option, i) => (
                  <button
                    key={option}
                    type="button"
                    role="menuitem"
                    autoFocus={i === 0}
                    onClick={() => choose(option)}
                    className="rounded-md px-2.5 py-1.5 text-left text-sm text-ink hover:bg-ink/6 focus-visible:bg-ink/8"
                  >
                    {t(`notifications.snooze.${option}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {tab !== "new" && (
          <button
            type="button"
            className={actionClass}
            onClick={() => onChange({ archived: false, snoozedUntil: null })}
          >
            {t(
              tab === "archived"
                ? "notifications.actions.restore"
                : "notifications.actions.unsnooze",
            )}
          </button>
        )}
      </div>
    </li>
  );
}
