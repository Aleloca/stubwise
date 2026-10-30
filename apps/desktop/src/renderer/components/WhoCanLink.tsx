import { Link, useRouter } from "@tanstack/react-router";
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
import { actionById, useProjects, useWhoCan } from "../data/queries";
import { useReasonWords } from "../pages/admin/WhoCanPage";

// «Who?» accanto a un bottone spento per permesso (shape admin-audit.md
// [AU 4], maintainer: un riquadro sul posto). La frase che dice chi può
// farlo resta; in coda il link apre un popover con le persone e il perché,
// le stesse di «Who can?» (`api.access.whoCan`, cioè `can()`), e «Open in Who
// can?» per andare oltre. R-G5: Sara, da un bottone di ACQ, vede solo
// persone di ACQ che vede. Niente lettura finché il riquadro è chiuso.

const WIDTH = 320;
/** Quante persone si nominano prima di «and 3 more». */
const SHOWN = 6;

export function WhoCanLink({
  action,
  projectId,
  projectCode,
}: {
  /** Un'azione del catalogo `ACTIONS` («approvePlan»). */
  action: string;
  /**
   * Il progetto del bottone; `null` per un'azione d'istanza. Chi conosce solo
   * il codice (una scheda della conversazione) lo omette: si ricava dal codice.
   */
  projectId?: string | null;
  /** Il codice del progetto, per il titolo e per «Open in Who can?». */
  projectCode?: string | null;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const def = actionById(action);

  const close = useCallback((restore: boolean) => {
    setAnchor(null);
    if (restore) button.current?.focus();
  }, []);

  // Un'altra pagina (tastiera, ⌘K) chiude il riquadro. Il router può
  // mancare: il link vive anche in schede montate fuori dalle rotte (la
  // conversazione nei suoi test).
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | null;
  useEffect(() => {
    if (!anchor || !router) return;
    return router.subscribe("onBeforeNavigate", () => setAnchor(null));
  }, [anchor, router]);

  if (!def) return null;
  const actionWords = t(def.labelKey);

  function toggle() {
    if (anchor) return close(false);
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
    // Verso l'alto se sotto non c'è posto per il riquadro (circa 320 px).
    const up = window.innerHeight - rect.bottom < 340 && rect.top > 340;
    setAnchor({ top: up ? rect.top - 6 : rect.bottom + 6, left, up });
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-label={t("whoCan.link.label", { action: actionWords })}
        data-who-can={action}
        onClick={toggle}
        // La misura della frase che lo porta (13 px quasi ovunque, 12 in una nota).
        className="rounded-sm font-medium text-ink underline-offset-2 hover:underline aria-expanded:underline"
      >
        {t("whoCan.link.who")}
      </button>
      {anchor &&
        createPortal(
          <WhoCanPopover
            action={action}
            actionWords={actionWords}
            projectId={def.scope === "project" ? (projectId ?? undefined) : null}
            projectCode={def.scope === "project" ? (projectCode ?? null) : null}
            anchor={anchor}
            button={button}
            onClose={close}
          />,
          document.body,
        )}
    </>
  );
}

function WhoCanPopover({
  action,
  actionWords,
  projectId,
  projectCode,
  anchor,
  button,
  onClose,
}: {
  action: string;
  actionWords: string;
  /** `undefined`: si ricava da `projectCode` fra i progetti visibili. */
  projectId: string | null | undefined;
  projectCode: string | null;
  anchor: { top: number; left: number; up: boolean };
  button: RefObject<HTMLButtonElement | null>;
  onClose: (restore: boolean) => void;
}) {
  const { t } = useTranslation();
  const reasonWords = useReasonWords();
  const projects = useProjects().data;
  const resolved =
    projectId !== undefined
      ? projectId
      : (projects?.find((p) => p.code === projectCode)?.id ?? null);
  const answer = useWhoCan(action, resolved, projectId !== undefined || !!projects);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);

  // Esc chiude anche a fuoco fuori e rende il fuoco al link; un clic fuori chiude e basta.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose(true);
    }
    function onPointer(e: PointerEvent) {
      const target = e.target as Node;
      if (ref.current?.contains(target) || button.current?.contains(target)) return;
      onClose(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose, button]);

  const data = answer.data;
  const people = data?.visible ? data.people : [];
  const rest = people.length - SHOWN;
  const search = projectCode ? { action, project: projectCode } : { action };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-who-can-popover={action}
      style={{
        left: anchor.left,
        width: WIDTH,
        ...(anchor.up ? { bottom: window.innerHeight - anchor.top } : { top: anchor.top }),
      }}
      className="menu-enter fixed z-40 flex max-w-[calc(100vw-16px)] flex-col rounded-lg border border-rule-strong bg-surface text-ink shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)] outline-none"
    >
      <h2 id={titleId} className="px-3 pt-3 pb-2 text-md font-semibold text-pretty text-ink">
        {projectCode
          ? t("whoCan.link.title", { action: actionWords, code: projectCode })
          : t("whoCan.link.titleInstance", { action: actionWords })}
      </h2>
      <div aria-live="polite" className="border-t border-rule px-3 py-2">
        {answer.isError ? (
          <div role="alert" className="flex items-center gap-2 py-1 text-sm text-ink">
            {t("whoCan.link.error")}
            <button
              type="button"
              onClick={() => void answer.refetch()}
              className="rounded-md border border-rule-strong px-2 py-0.5 text-sm font-medium hover:bg-ink/6"
            >
              {t("whoCan.link.retry")}
            </button>
          </div>
        ) : answer.isPending ? (
          <div aria-busy="true" className="skeleton-breathe flex flex-col gap-3 py-1.5">
            <span role="status" className="sr-only">
              {t("whoCan.link.loading")}
            </span>
            {[70, 55, 62].map((w) => (
              <span key={w} className="h-2.5 rounded-sm bg-ink/8" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : people.length === 0 ? (
          <p className="py-1 text-sm text-ink-muted">{t("whoCan.link.empty")}</p>
        ) : (
          <ul className="flex flex-col">
            {people.slice(0, SHOWN).map((p) => (
              <li
                key={p.personId}
                data-who-row={p.personId}
                className="flex min-w-0 items-baseline gap-2 py-1"
              >
                <span className="shrink-0 text-md font-medium text-ink">{p.name}</span>
                <span className="min-w-0 truncate text-sm text-ink-muted">
                  {p.reasons[0] ? reasonWords(p.reasons[0]) : ""}
                </span>
              </li>
            ))}
            {rest > 0 && (
              <li className="py-1 text-sm text-ink-muted">
                {t("whoCan.link.more", { count: rest })}
              </li>
            )}
          </ul>
        )}
      </div>
      <div className="border-t border-rule px-3 py-2">
        <Link
          to="/admin/$section"
          params={{ section: "who-can" }}
          search={search}
          className="text-sm font-medium text-ink underline-offset-2 hover:underline"
        >
          {t("whoCan.link.open")}
        </Link>
      </div>
    </div>
  );
}
