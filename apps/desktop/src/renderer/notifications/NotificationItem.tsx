import { useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { SubscriptionState } from "../data/alerts";
import type { AppNotification, Project } from "../data/types";
import { Menu, itemClass } from "../tasks-ui/Menu";
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

/**
 * Un avviso del catalogo visto dal pannello: il progetto, il nome del suo
 * tipo e lo stato di adesso dell'iscrizione (letto dalle Preferenze).
 */
export interface AlertOfNotification {
  code: string;
  label: string;
  /** `off`: già spento dopo l'avviso [A 17]; `undefined` se la riga non si legge (ancora). */
  state: SubscriptionState | undefined;
  onMute: () => void;
  onTurnBackOn: () => void;
  onOpenSettings: () => void;
}

interface Props {
  notification: AppNotification;
  project: Pick<Project, "code" | "name"> | undefined;
  /** Solo per i tipi del catalogo, in un progetto: il menu «⋯» degli avvisi. */
  alert?: AlertOfNotification;
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
export function NotificationItem({ notification: n, project, alert, onOpen, onChange }: Props) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  // L'obbligo di chi guarda (un solo motivo: il livello dati lascia solo il suo).
  const why = n.mandatory?.[0]?.reason;
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
          {/* Perché arriva anche con l'iscrizione spenta: sempre scritto [A 16]. */}
          {why && (
            <span data-mandatory-reason className="mt-1 block text-xs text-ink-faint">
              {t(`alerts.panel.why.${why}`)}
            </span>
          )}
        </span>
        <DeptStrip departmentId={n.departmentId} />
      </button>

      {/* Le azioni non riservano spazio: si sovrappongono all'angolo in alto a
          destra (sopra il «quando») al passaggio o al fuoco, e restano
          raggiungibili da tastiera. */}
      <div
        data-notification-actions
        className={`absolute top-2 right-3 flex items-center gap-1 bg-[color-mix(in_oklch,var(--ink)_4%,var(--surface))] pl-2 group-focus-within:opacity-100 group-hover:opacity-100 ${menuOpen || moreOpen ? "opacity-100" : "opacity-0"}`}
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
        {alert && (
          <div className="relative">
            <button
              ref={moreButton}
              type="button"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-label={t("alerts.panel.more")}
              className={`${actionClass} px-1.5`}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <svg
                viewBox="0 0 16 16"
                width={14}
                height={14}
                fill="currentColor"
                aria-hidden="true"
                focusable="false"
              >
                <circle cx="3.5" cy="8" r="1.25" />
                <circle cx="8" cy="8" r="1.25" />
                <circle cx="12.5" cy="8" r="1.25" />
              </svg>
            </button>
            {moreOpen && (
              <AlertMenu
                alert={alert}
                mandatory={why !== undefined}
                onClose={(restore) => {
                  setMoreOpen(false);
                  if (restore) moreButton.current?.focus();
                }}
              />
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Il menu «⋯» di un avviso del catalogo [A 15]: «Don't alert me about this
 * in AUD» (non sugli obbligatori [A 16]; da già spento diventa «Alerts like
 * this are off» + «Turn back on» [A 17]) e «Alert settings for AUD».
 */
function AlertMenu({
  alert,
  mandatory,
  onClose,
}: {
  alert: AlertOfNotification;
  mandatory: boolean;
  onClose: (restoreFocus: boolean) => void;
}) {
  const { t } = useTranslation();
  const code = alert.code;
  const run = (action: () => void) => () => {
    onClose(true);
    action();
  };
  return (
    <Menu label={t("alerts.panel.more")} onClose={onClose} align="right">
      {!mandatory && alert.state === "off" && (
        <>
          <p role="menuitem" aria-disabled="true" tabIndex={-1} className={`${itemClass} text-ink-muted hover:bg-transparent`}>
            {t("alerts.panel.alreadyOff", { code })}
          </p>
          <button type="button" role="menuitem" className={itemClass} onClick={run(alert.onTurnBackOn)}>
            {t("alerts.panel.turnBackOn")}
          </button>
        </>
      )}
      {!mandatory && alert.state === "on" && (
        <button type="button" role="menuitem" className={itemClass} onClick={run(alert.onMute)}>
          {t("alerts.panel.mute", { code })}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        onClick={() => {
          onClose(false);
          alert.onOpenSettings();
        }}
      >
        {t("alerts.panel.settings", { code })}
      </button>
    </Menu>
  );
}
