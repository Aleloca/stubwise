import { Link, useRouterState } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { SubscriptionRow as Row } from "../data/alerts";
import { useAlertSubscriptions } from "../data/queries";
import { useMuteProject } from "../pages/preferences/useAlertActions";
import { FamilyList, SWITCH_COL, summaryText } from "../pages/preferences/SubscriptionRow";

// Il popover «Alerts» nella testata della colonna del progetto (shape
// alerts.md): le stesse righe della pagina, in forma compatta, sulla stessa
// query — un cambio qui si vede nella pagina e viceversa, senza ricaricare.

const WIDTH = 340;

/**
 * Tutte le iscrizioni del progetto sono spente (R-K16): la campanella si
 * barra anche se qualche avviso arriva comunque per obbligo.
 */
const allOff = (rows: Row[]) => rows.every((r) => r.state !== "on");

/** Qualche avviso arriva comunque: una riga solo obbligatoria, o un obbligo condizionale. */
const someStillArrive = (rows: Row[]) =>
  rows.some((r) => r.state === "mandatory" || r.mandatory.length > 0);

function BellGlyph({ off }: { off: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 11.5V7.25a4 4 0 0 1 8 0v4.25l1 1H3z" />
      <path d="M6.75 13.75a1.4 1.4 0 0 0 2.5 0" />
      {off && <path d="m2.5 2.5 11 11" />}
    </svg>
  );
}

/**
 * La campanella del progetto (28 px, sulla riga del codice): barrata quando
 * tutte le iscrizioni sono spente (R-K16); allora il suggerimento (e il
 * popover) dice che alcuni avvisi arrivano comunque, se è così. Apre un
 * popover non modale: Esc o un clic fuori lo chiudono e il fuoco torna qui.
 */
export function ProjectAlerts({ projectId, code }: { projectId: string; code: string }) {
  const { t } = useTranslation();
  const subs = useAlertSubscriptions();
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const project = subs.data?.find((p) => p.projectId === projectId);
  const rows = project?.rows ?? [];
  const off = project !== undefined && allOff(rows);
  const summary = project
    ? [
        summaryText(t, rows),
        ...(off && someStillArrive(rows) ? [t("alerts.bell.stillArrive")] : []),
      ].join(" · ")
    : "";

  const close = useCallback((restore: boolean) => {
    setAnchor(null);
    if (restore) button.current?.focus();
  }, []);

  // Un altro progetto o un'altra pagina (tastiera, ⌘K) chiude il popover: il
  // componente non si rimonta, e resterebbe aperto sul progetto di prima.
  const path = useRouterState({ select: (st) => st.location.pathname });
  useEffect(() => setAnchor(null), [projectId, path]);

  function toggle() {
    if (anchor) return close(false);
    const rect = button.current?.getBoundingClientRect();
    const column = button.current?.closest("[data-zone='column']")?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(
      8,
      Math.min((column?.left ?? rect.left) + 8, window.innerWidth - WIDTH - 8),
    );
    setAnchor({ top: rect.bottom + 6, left });
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-label={t("alerts.bell.label", { code })}
        title={summary ? t("alerts.bell.tooltip", { code, summary }) : undefined}
        data-alerts-off={off || undefined}
        onClick={toggle}
        className="grid size-7 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink"
      >
        <BellGlyph off={off} />
      </button>
      {anchor &&
        createPortal(
          <Popover
            projectId={projectId}
            code={code}
            anchor={anchor}
            button={button}
            onClose={close}
          />,
          document.body,
        )}
    </>
  );
}

function Popover({
  projectId,
  code,
  anchor,
  button,
  onClose,
}: {
  projectId: string;
  code: string;
  anchor: { top: number; left: number };
  button: RefObject<HTMLButtonElement | null>;
  onClose: (restore: boolean) => void;
}) {
  const { t } = useTranslation();
  const subs = useAlertSubscriptions();
  const muteProject = useMuteProject();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const project = subs.data?.find((p) => p.projectId === projectId);

  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);

  // Esc chiude anche a fuoco fuori; un clic fuori (non sulla campanella) chiude senza spostare il fuoco.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose(true);
    }
    function onPointer(e: PointerEvent) {
      const target = e.target as Node;
      if (ref.current?.contains(target) || button.current?.contains(target)) return;
      // Un toast (Annulla) o un suggerimento non chiudono il popover.
      if ((target as Element).closest?.("[data-toast], [role='tooltip']")) return;
      onClose(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose, button]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{ top: anchor.top, left: anchor.left, width: WIDTH }}
      className="menu-enter fixed z-40 flex max-w-[calc(100vw-16px)] flex-col rounded-lg border border-rule-strong bg-surface text-ink shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)] outline-none"
    >
      <div className="flex items-baseline justify-between gap-3 px-3 pt-3 pb-1">
        <h2 id={titleId} className="text-md font-semibold text-ink">
          {t("alerts.bell.title", { code })}
        </h2>
        {project && (
          <span className="truncate text-xs text-ink-faint">{summaryText(t, project.rows)}</span>
        )}
      </div>
      {project && allOff(project.rows) && someStillArrive(project.rows) && (
        <p data-still-arrive className="px-3 pb-1 text-sm text-ink-muted">
          {t("alerts.bell.stillArrive")}
        </p>
      )}
      {subs.isError ? (
        <p role="alert" className="flex items-center gap-2 px-3 py-3 text-sm text-ink">
          {t("alerts.bell.error")}
          <button
            type="button"
            onClick={() => void subs.refetch()}
            className="rounded-md border border-rule-strong px-2 py-0.5 text-sm font-medium text-ink hover:bg-ink/6"
          >
            {t("alerts.retry")}
          </button>
        </p>
      ) : !project ? (
        <p role="status" className="px-3 py-3 text-sm text-ink-muted">
          {t("taskUi.states.loading")}
        </p>
      ) : (
        <>
          <div className="px-3">
            <div className="flex justify-end border-b border-rule pb-1">
              <span className={`${SWITCH_COL} text-center text-xs font-medium text-ink-muted`}>
                {t("alerts.app")}
              </span>
              <span className={`${SWITCH_COL} text-center text-xs font-medium text-ink-muted`}>
                {t("alerts.phone")}
              </span>
            </div>
            <p className="pt-1 text-xs text-ink-faint">{t("alerts.prototypePhone")}</p>
          </div>
          <div className="max-h-[420px] overflow-y-auto px-3 pb-2">
            {project.rows.length === 0 ? (
              <p className="py-2 text-sm text-ink-muted">{t("alerts.nothingHere")}</p>
            ) : (
              <FamilyList project={project} rows={project.rows} compact />
            )}
          </div>
        </>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-rule px-2 py-2">
        <button
          type="button"
          disabled={!project}
          onClick={() => project && void muteProject(project)}
          className="rounded-md px-2 py-1 text-sm font-medium text-ink-muted hover:bg-ink/6 hover:text-ink disabled:opacity-40"
        >
          {t("alerts.bell.turnOff")}
        </button>
        <Link
          to="/preferences/$section"
          params={{ section: "notifications" }}
          search={{ project: code }}
          onClick={() => onClose(false)}
          className="rounded-md px-2 py-1 text-sm font-medium text-ink hover:bg-ink/6"
        >
          {t("alerts.bell.all")}
        </Link>
      </div>
    </div>
  );
}
