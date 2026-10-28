import { Link, useRouterState } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import type { ProjectSubscriptions } from "../../data/alerts";
import { useAlertSubscriptions } from "../../data/queries";
import { useViewer } from "../../data/viewer";
import { Tooltip } from "../../layout/Tooltip";
import { PageError } from "../../tasks-ui/PageStates";
import { ChevronGlyph, InfoGlyph } from "./glyphs";
import { GroupMenu, matchesProject } from "./GroupMenu";
import { FamilyList, SWITCH_COL, summaryText } from "./SubscriptionRow";

// Preferenze → Notifiche (shape alerts.md): il registro delle iscrizioni.
// Un gruppo per progetto (i fissati prima, aperti), dentro le famiglie, a
// destra due colonne di interruttori allineate per tutta la pagina.

/** Aperto/chiuso dei gruppi, per persona: comodità, non stato (shape [A 4]). */
const openKey = (personId: string) => `stubwise.alerts.open.${personId}`;

function readOpen(personId: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(openKey(personId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * Scrive solo i gruppi toccati, sopra ciò che la persona aveva già: dopo un
 * cambio di persona lo stato in memoria resta (shape §5), ma nello storage
 * della nuova persona non finisce la mappa di quella di prima.
 */
function writeOpen(personId: string, change: Record<string, boolean>) {
  try {
    window.localStorage.setItem(
      openKey(personId),
      JSON.stringify({ ...readOpen(personId), ...change }),
    );
  } catch {
    /* niente storage: si ricorda solo finché la pagina è aperta */
  }
}

const buttonClass =
  "inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:bg-ink/10 disabled:pointer-events-none disabled:opacity-40";

/** L'intestazione delle colonne App / Phone ⓘ: agganciata in alto mentre si scorre. */
function ColumnsHeader() {
  const { t } = useTranslation();
  return (
    <div
      data-columns-header
      className="sticky top-0 z-10 flex justify-end border-b border-rule bg-ground py-2"
    >
      <span className={`${SWITCH_COL} text-center text-xs font-medium text-ink-muted`}>
        {t("alerts.app")}
      </span>
      <span
        className={`${SWITCH_COL} flex items-center justify-center gap-1 text-xs font-medium text-ink-muted`}
      >
        {t("alerts.phone")}
        <Tooltip label={t("alerts.prototypePhone")}>
          <button
            type="button"
            aria-label={t("alerts.prototypePhone")}
            className="grid size-4 place-items-center rounded-full text-ink-faint hover:text-ink"
          >
            <InfoGlyph />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

/** Uno scheletro con la forma vera: tre intestazioni, sei righe sotto la prima. */
function Skeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {[0, 1, 2].map((g) => (
        <div key={g} className="border-b border-rule">
          <div className="flex h-10 items-center gap-3">
            <span className={`h-2.5 w-8 ${bar}`} />
            <span className={`h-2.5 w-40 ${bar}`} />
            <span className={`ml-auto h-2.5 w-24 ${bar}`} />
          </div>
          {g === 0 &&
            [64, 48, 72, 56, 44, 60].map((w, i) => (
              <div key={i} className="flex items-center gap-4 py-3 pl-6">
                <span className="flex flex-1 flex-col gap-1.5">
                  <span className={`h-2.5 ${bar}`} style={{ width: `${w / 2}%` }} />
                  <span className={`h-2 ${bar}`} style={{ width: `${w}%` }} />
                </span>
                <span className={`h-[18px] w-8 rounded-full ${bar}`} />
                <span className={`mr-3 h-[18px] w-8 rounded-full ${bar}`} />
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

/**
 * La sezione Notifiche. `focusCode` (`?project=AUD`): quel gruppo si apre, va
 * in vista e prende il fuoco (popover, pannello, ⌘K).
 */
export function NotificationsSection({ focusCode }: { focusCode?: string }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const subs = useAlertSubscriptions();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>(() => readOpen(viewer.personId));
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedId = useId();
  const othersId = useId();

  const isOpen = useCallback((p: ProjectSubscriptions) => open[p.projectId] ?? p.pinned, [open]);
  const setGroups = (change: Record<string, boolean>) =>
    setOpen((prev) => {
      writeOpen(viewer.personId, change);
      return { ...prev, ...change };
    });

  // L'ancora: apre il gruppo, lo porta in vista e gli dà il fuoco, una volta
  // per navigazione (ripetere «Alert settings for AUD» con la pagina già su
  // `?project=AUD` lo rifà: la chiave della navigazione è nuova).
  const navKey = useRouterState({ select: (s) => s.location.state.key ?? s.location.href });
  const anchored = useRef<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const focusProject = subs.data?.find((p) => p.code === focusCode);
  useEffect(() => {
    const at = focusProject ? `${focusProject.code}:${navKey}` : null;
    if (!focusProject || anchored.current === at) return;
    anchored.current = at;
    pendingFocus.current = focusProject.code;
    setOpen((prev) => ({ ...prev, [focusProject.projectId]: true }));
    setQuery("");
  }, [focusProject, navKey]);
  useLayoutEffect(() => {
    const code = pendingFocus.current;
    const header =
      code && listRef.current?.querySelector<HTMLElement>(`[data-group-header="${code}"]`);
    if (!header) return;
    pendingFocus.current = null;
    header.scrollIntoView?.({ block: "start" });
    header.focus();
  });

  const shown = useMemo(
    () => (subs.data ?? []).filter((p) => matchesProject(p, query)),
    [subs.data, query],
  );
  // Una ricerca apre i gruppi trovati.
  const searching = query.trim() !== "";
  const groupOpen = (p: ProjectSubscriptions) => (searching ? true : isOpen(p));

  function onPageKeyDown(e: KeyboardEvent<HTMLElement>) {
    const target = e.target as HTMLElement;
    const typing = target.closest("input, textarea, [role='menu'], [role='dialog']");
    if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      searchRef.current?.focus();
    }
  }

  function onHeaderKeyDown(e: KeyboardEvent<HTMLButtonElement>, p: ProjectSubscriptions) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const headers = [
        ...(listRef.current?.querySelectorAll<HTMLElement>("[data-group-header]") ?? []),
      ];
      const at = headers.indexOf(e.currentTarget);
      const next = headers[at + (e.key === "ArrowDown" ? 1 : -1)];
      next?.focus();
    } else if (e.key === "ArrowRight" && !groupOpen(p)) {
      e.preventDefault();
      setGroups({ [p.projectId]: true });
    } else if (e.key === "ArrowLeft" && groupOpen(p)) {
      e.preventDefault();
      setGroups({ [p.projectId]: false });
    }
  }

  const pinned = shown.filter((p) => p.pinned);
  const others = shown.filter((p) => !p.pinned);

  let body;
  if (subs.isError && !subs.data) {
    body = <PageError message={t("alerts.loadError")} onRetry={() => void subs.refetch()} />;
  } else if (subs.isPending) {
    body = <Skeleton />;
  } else if (subs.data.length === 0) {
    body = <p className="py-6 text-md text-ink-muted">{t("alerts.noProjects")}</p>;
  } else if (shown.length === 0) {
    body = (
      <p className="flex items-center gap-2 py-6 text-md text-ink-muted">
        {t("alerts.noMatch", { query: query.trim() })}
        <button type="button" className={buttonClass} onClick={() => setQuery("")}>
          {t("alerts.clear")}
        </button>
      </p>
    );
  } else {
    const group = (list: ProjectSubscriptions[]) =>
      list.map((p) => (
        <ProjectGroup
          key={p.projectId}
          project={p}
          open={groupOpen(p)}
          onToggle={() => setGroups({ [p.projectId]: !groupOpen(p) })}
          onHeaderKeyDown={(e) => onHeaderKeyDown(e, p)}
          all={subs.data}
        />
      ));
    body = (
      <>
        {pinned.length > 0 && (
          <section aria-labelledby={pinnedId}>
            <h2 id={pinnedId} className="heading-group pt-5 pb-1">
              {t("alerts.pinned")}
            </h2>
            {group(pinned)}
          </section>
        )}
        {others.length > 0 && (
          <section aria-labelledby={othersId}>
            <h2 id={othersId} className="heading-group pt-6 pb-1">
              {t(pinned.length > 0 ? "alerts.others" : "alerts.projects")}
            </h2>
            {group(others)}
          </section>
        )}
      </>
    );
  }

  const ready = subs.data !== undefined && subs.data.length > 0;
  // Una rilettura fallita con i dati già in pagina: un avviso, la pagina resta
  // (scorrimento, fuoco e gruppi aperti non si perdono).
  const staleError = subs.isError && subs.data !== undefined;
  return (
    <section
      onKeyDown={onPageKeyDown}
      className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]"
    >
      <div className="max-w-[760px]">
        <h1 className="text-2xl font-semibold text-ink">{t("alerts.title")}</h1>
        <p className="mt-2 max-w-[62ch] text-md text-ink-muted">{t("alerts.intro")}</p>
        {ready && (
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("alerts.find")}
              placeholder={t("alerts.findPlaceholder")}
              className="h-8 w-72 min-w-0 rounded-md border border-rule-strong bg-transparent px-2.5 text-md text-ink placeholder:text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:border-ink/40 focus-visible:border-transparent"
            />
            <span className="ml-auto flex gap-1">
              {/* Con una ricerca i trovati restano aperti: aprire e chiudere tutto non c'entra. */}
              <button
                type="button"
                className={buttonClass}
                disabled={searching}
                onClick={() => setGroups(Object.fromEntries(shown.map((p) => [p.projectId, true])))}
              >
                {t("alerts.expandAll")}
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={searching}
                onClick={() =>
                  setGroups(Object.fromEntries(shown.map((p) => [p.projectId, false])))
                }
              >
                {t("alerts.collapseAll")}
              </button>
            </span>
          </div>
        )}
        {staleError && (
          <p
            role="alert"
            className="mt-4 flex flex-wrap items-center gap-2 border-y border-rule py-2 text-sm text-ink"
          >
            {t("alerts.reloadError")}
            <button type="button" className={buttonClass} onClick={() => void subs.refetch()}>
              {t("alerts.retry")}
            </button>
          </p>
        )}
        <div ref={listRef} className="mt-4">
          {ready && <ColumnsHeader />}
          {body}
        </div>
        <NotSetHere />
      </div>
    </section>
  );
}

/** «Not set here»: ciò che non si regola qui, in una riga di prosa (shape [A 13]). */
/** Il link di «Home → Decide» dentro la frase tradotta (`Trans` gli passa il testo). */
function HomeLink({ children }: { children?: ReactNode }) {
  return (
    <Link
      to="/home"
      className="text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
    >
      {children}
    </Link>
  );
}

function NotSetHere() {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-10 border-t border-rule pt-4">
      <h2 id={id} className="heading-group">
        {t("alerts.notSet.title")}
      </h2>
      <p className="mt-2 max-w-[62ch] text-sm text-ink-muted">
        {t("alerts.notSet.security")}{" "}
        {/* Un messaggio solo col link dentro: l'ordine delle parole è della lingua. */}
        <Trans
          i18nKey="alerts.notSet.decisions"
          components={{ home: <HomeLink /> }}
        />{" "}
        {t("alerts.notSet.rest")}
      </p>
    </section>
  );
}

/** Il gruppo di un progetto: intestazione (40 px) e, aperto, le famiglie. */
function ProjectGroup({
  project: p,
  open,
  onToggle,
  onHeaderKeyDown,
  all,
}: {
  project: ProjectSubscriptions;
  open: boolean;
  onToggle: () => void;
  onHeaderKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  all: ProjectSubscriptions[];
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  return (
    <div data-project-group={p.code} className="border-b border-rule">
      <div className="flex items-center gap-1">
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            data-group-header={p.code}
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={onToggle}
            onKeyDown={onHeaderKeyDown}
            className="-ml-2 flex h-10 w-[calc(100%+8px)] scroll-mt-12 min-w-0 items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
          >
            <ChevronGlyph open={open} />
            <span className="num w-10 shrink-0 text-sm font-semibold text-ink">{p.code}</span>
            <span title={p.name} className="min-w-0 truncate text-md text-ink">
              {p.name}
            </span>
            <span className="ml-auto shrink-0 pl-3 text-sm text-ink-faint">
              {summaryText(t, p.rows)}
            </span>
          </button>
        </h3>
        <GroupMenu project={p} all={all} />
      </div>
      {open && (
        <div id={bodyId} className="alert-group-enter grid">
          <div className="min-h-0 overflow-hidden pb-3 pl-[34px]">
            {p.rows.length === 0 ? (
              <p className="py-2 text-sm text-ink-muted">{t("alerts.nothingHere")}</p>
            ) : (
              <FamilyList project={p} rows={p.rows} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
