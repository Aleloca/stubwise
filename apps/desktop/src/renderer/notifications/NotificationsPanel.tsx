import { useRouter } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  useMarkNotification,
  useNotifications,
  useProjects,
  useReachChatMessage,
} from "../data/queries";
import type { AppNotification } from "../data/types";
import { useToast } from "../tasks-ui/Toast";
import { useRestoreFocus } from "../layout/useRestoreFocus";
import { NOTIFICATIONS_EVENT } from "../layout/useShortcuts";
import { DeptLegend } from "../layout/DeptStrip";
import { NotificationItem, type Change } from "./NotificationItem";
import { tabOf, type Tab } from "./time";

const TABS: Tab[] = ["new", "snoozed", "archived"];

/**
 * Il pannello delle notifiche: si apre da destra con l'evento
 * `stubwise:notifications` (la campanella del binario). Non è modale — sta
 * sopra l'area di lavoro, senza velo — e chiude con Esc, con la X o
 * navigando; il fuoco torna dov'era. Solo informazioni: le decisioni vivono
 * nella Home.
 */
export function NotificationsPanel() {
  const [open, setOpen] = useState(false);
  const remember = useRestoreFocus(open);

  useEffect(() => {
    function onToggle() {
      setOpen((wasOpen) => {
        if (!wasOpen) remember();
        return !wasOpen;
      });
    }
    window.addEventListener(NOTIFICATIONS_EVENT, onToggle);
    return () => window.removeEventListener(NOTIFICATIONS_EVENT, onToggle);
  }, [remember]);

  const close = useCallback(() => setOpen(false), []);

  if (!open) return null;
  return createPortal(<Panel onClose={close} />, document.body);
}

function Panel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("new");
  const notifications = useNotifications();
  const projects = useProjects();
  const mark = useMarkNotification();
  const reach = useReachChatMessage();
  const toast = useToast();
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    new: null,
    snoozed: null,
    archived: null,
  });

  useEffect(() => {
    tabRefs.current.new?.focus();
  }, []);

  const projectsById = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p])),
    [projects.data],
  );

  const grouped = useMemo(() => {
    const out: Record<Tab, NonNullable<typeof notifications.data>> = {
      new: [],
      snoozed: [],
      archived: [],
    };
    for (const n of notifications.data ?? []) out[tabOf(n)].push(n);
    for (const list of Object.values(out)) {
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return out;
  }, [notifications.data]);

  const visible = grouped[tab];

  async function openLink(n: AppNotification) {
    // Una menzione della Chat si rilegge prima di andarci: il messaggio può
    // essere stato eliminato, o il canale non più leggibile, da quando la
    // lista è stata letta. Allora un avviso, si resta qui, e la lista si
    // aggiorna (la notifica sparisce, senza testo).
    if (n.chatMessageId !== undefined && !(await reach(n.chatMessageId))) {
      toast.error(t("chat.search.unavailable"));
      void notifications.refetch();
      return;
    }
    mark.mutate({ id: n.id, change: { read: true } });
    router.history.push(n.link.replace(/^#/, ""));
    onClose();
  }

  // Esc chiude anche a fuoco fuori dal pannello (il pannello non è modale).
  // Se qualcuno l'ha già consumata (menu del rinvio, palette) non si raddoppia.
  useEffect(() => {
    function onDocumentKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [onClose]);

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  function onTabKeyDown(e: ReactKeyboardEvent, index: number) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length]!;
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={t("notifications.title")}
      onKeyDown={onKeyDown}
      className="panel-enter fixed inset-y-0 right-0 z-30 flex w-[400px] max-w-full flex-col border-l border-rule-strong bg-surface text-ink"
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-rule pr-3 pl-4">
        <h2 className="text-lg font-semibold text-ink">{t("notifications.title")}</h2>
        <button
          type="button"
          aria-label={t("notifications.close")}
          onClick={onClose}
          className="grid size-8 place-items-center rounded-lg text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
        >
          <svg
            viewBox="0 0 16 16"
            width={16}
            height={16}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      <div
        role="tablist"
        aria-label={t("notifications.title")}
        className="flex shrink-0 gap-1 border-b border-rule px-3 py-2"
      >
        {TABS.map((id, index) => {
          const selected = id === tab;
          const count = grouped[id].length;
          return (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[id] = el;
              }}
              type="button"
              role="tab"
              id={`notif-tab-${id}`}
              aria-selected={selected}
              aria-controls="notif-tabpanel"
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${
                selected
                  ? "bg-ink/10 font-semibold text-ink"
                  : "text-ink-muted hover:bg-ink/6 hover:text-ink"
              }`}
            >
              {t(`notifications.tabs.${id}`)}
              <span className="num text-xs text-ink-muted">{count}</span>
            </button>
          );
        })}
      </div>

      <div
        id="notif-tabpanel"
        role="tabpanel"
        aria-labelledby={`notif-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {notifications.isError ? (
          <div role="alert" className="px-6 py-10 text-center">
            <p className="text-md text-ink">{t("notifications.error")}</p>
            <button
              type="button"
              onClick={() => void notifications.refetch()}
              className="mt-3 rounded-md border border-rule-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-ink/6"
            >
              {t("notifications.retry")}
            </button>
          </div>
        ) : notifications.isPending ? (
          <p role="status" className="px-6 py-10 text-center text-sm text-ink-muted">
            {t("notifications.loading")}
          </p>
        ) : visible.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-md text-ink">{t(`notifications.empty.${tab}.title`)}</p>
            <p className="mt-1 text-sm text-ink-muted">{t(`notifications.empty.${tab}.hint`)}</p>
          </div>
        ) : (
          <ul>
            {visible.map((n) => (
              <NotificationItem
                key={n.id}
                notification={n}
                project={n.projectId ? projectsById.get(n.projectId) : undefined}
                onOpen={() => void openLink(n)}
                onChange={(change: Change) => mark.mutate({ id: n.id, change })}
              />
            ))}
          </ul>
        )}
      </div>
      {/* Legenda dei reparti delle notifiche mostrate (solo quelli presenti). */}
      {visible.some((n) => n.departmentId) && !notifications.isError && (
        <div className="shrink-0 border-t border-rule px-4 py-2">
          <DeptLegend departmentIds={visible.map((n) => n.departmentId)} wrap />
        </div>
      )}
    </aside>
  );
}
