import { Link, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { ProjectSubscriptions, SubscriptionRow as Row } from "../../data/alerts";
import {
  useAlertSubscriptions,
  useCopyAlertSubscriptions,
  useMuteProjectAlerts,
} from "../../data/queries";
import { useViewer } from "../../data/viewer";
import { Tooltip } from "../../layout/Tooltip";
import { Dialog } from "../../tasks-ui/Dialog";
import { Menu, itemClass } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
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

function writeOpen(personId: string, value: Record<string, boolean>) {
  try {
    window.localStorage.setItem(openKey(personId), JSON.stringify(value));
  } catch {
    /* niente storage: si ricorda solo finché la pagina è aperta */
  }
}

const matches = (p: ProjectSubscriptions, q: string) => {
  const needle = q.trim().toLowerCase();
  return !needle || p.code.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle);
};

const buttonClass =
  "inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:bg-ink/10";

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

export function InfoGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={13}
      height={13}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4M8 4.75h.01" />
    </svg>
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
      const next = { ...prev, ...change };
      writeOpen(viewer.personId, next);
      return next;
    });

  // L'ancora: apre il gruppo, lo porta in vista e gli dà il fuoco, una volta per codice.
  const anchored = useRef<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const focusProject = subs.data?.find((p) => p.code === focusCode);
  useEffect(() => {
    if (!focusProject || anchored.current === focusProject.code) return;
    anchored.current = focusProject.code;
    pendingFocus.current = focusProject.code;
    setOpen((prev) => ({ ...prev, [focusProject.projectId]: true }));
    setQuery("");
  }, [focusProject]);
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
    () => (subs.data ?? []).filter((p) => matches(p, query)),
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
  if (subs.isError) {
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

  const ready = subs.data !== undefined && !subs.isError && subs.data.length > 0;
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
              <button
                type="button"
                className={buttonClass}
                onClick={() => setGroups(Object.fromEntries(shown.map((p) => [p.projectId, true])))}
              >
                {t("alerts.expandAll")}
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() =>
                  setGroups(Object.fromEntries(shown.map((p) => [p.projectId, false])))
                }
              >
                {t("alerts.collapseAll")}
              </button>
            </span>
          </div>
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
function NotSetHere() {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-10 border-t border-rule pt-4">
      <h2 id={id} className="heading-group">
        {t("alerts.notSet.title")}
      </h2>
      <p className="mt-2 max-w-[62ch] text-sm text-ink-muted">
        {t("alerts.notSet.security")} {t("alerts.notSet.decisionsBefore")}{" "}
        <Link
          to="/home"
          className="text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
        >
          {t("alerts.notSet.decisionsLink")}
        </Link>
        . {t("alerts.notSet.rest")}
      </p>
    </section>
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 text-ink-muted transition-transform duration-[var(--duration-fast)] ease-out ${open ? "rotate-90" : ""}`}
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
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

function MoreGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}

/** «Spegni tutto» con «Annulla» nel toast (shape [A 11]): la usano il gruppo e il popover. */
export function useMuteProject() {
  const { t } = useTranslation();
  const mute = useMuteProjectAlerts();
  const toast = useToast();
  return (p: Pick<ProjectSubscriptions, "projectId" | "code">) =>
    mute.mutateAsync(p.projectId).then(
      (done) =>
        toast.show(t("alerts.offDone", { code: p.code }), {
          action: { label: t("alerts.undo"), run: () => void done.undo() },
        }),
      () => toast.error(t("alerts.bulkError", { code: p.code })),
    );
}

/** Il menu «⋯» del gruppo: «Same as another project…», «Turn everything off», «Open». */
function GroupMenu({
  project: p,
  all,
}: {
  project: ProjectSubscriptions;
  all: ProjectSubscriptions[];
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const muteProject = useMuteProject();
  const [step, setStep] = useState<"closed" | "main" | "pick">("closed");
  const [filter, setFilter] = useState("");
  const [copyFrom, setCopyFrom] = useState<ProjectSubscriptions | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const close = useCallback((restore: boolean) => {
    setStep("closed");
    setFilter("");
    if (restore) buttonRef.current?.focus();
  }, []);
  useEffect(() => {
    if (step === "pick") filterRef.current?.focus();
  }, [step]);

  const candidates = all.filter((o) => o.projectId !== p.projectId && matches(o, filter));
  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={step !== "closed"}
        aria-label={t("alerts.menu.label", { code: p.code })}
        onClick={() => (step === "closed" ? setStep("main") : close(false))}
        className="grid size-8 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink"
      >
        <MoreGlyph />
      </button>
      {step === "main" && (
        <Menu label={t("alerts.menu.label", { code: p.code })} onClose={close} align="right">
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => setStep("pick")}
          >
            {t("alerts.menu.same")}
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              close(true);
              void muteProject(p);
            }}
          >
            {t("alerts.menu.off", { code: p.code })}
          </button>
          <div role="separator" className="my-1 border-t border-rule" />
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              close(false);
              void navigate({
                to: "/p/$code/$section",
                params: { code: p.code, section: "overview" },
              });
            }}
          >
            {t("alerts.menu.open", { code: p.code })}
          </button>
        </Menu>
      )}
      {step === "pick" && (
        <Menu label={t("alerts.menu.pick")} onClose={close} align="right">
          <input
            ref={filterRef}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={t("alerts.menu.pick")}
            placeholder={t("alerts.findPlaceholder")}
            className="mb-1 h-8 w-full min-w-0 shrink-0 rounded-md border border-rule-strong bg-transparent px-2 text-sm text-ink placeholder:text-ink-faint"
          />
          {candidates.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-ink-muted">{t("alerts.menu.none")}</p>
          )}
          {candidates.map((o) => (
            <button
              key={o.projectId}
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                close(false);
                setCopyFrom(o);
              }}
            >
              <span className="num w-9 shrink-0 text-xs font-semibold text-ink">{o.code}</span>
              <span className="min-w-0 truncate">{o.name}</span>
            </button>
          ))}
        </Menu>
      )}
      {copyFrom && (
        <CopyDialog
          from={copyFrom}
          to={p}
          onClose={() => {
            setCopyFrom(null);
            buttonRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

type Channel = "off" | "app" | "both";
const channelOf = (r: Row): Channel => (!r.app ? "off" : r.phone ? "both" : "app");
const writable = (r: Row | undefined): r is Row => r?.state === "on" || r?.state === "off";

/** Quante righe di `to` cambierebbero prendendo lo stato di `from` (solo quelle scrivibili da entrambe le parti). */
export function copyDiff(from: ProjectSubscriptions, to: ProjectSubscriptions) {
  const source = new Map(from.rows.map((r) => [r.type, r]));
  return to.rows.flatMap((r) => {
    const s = source.get(r.type);
    if (!writable(r) || !writable(s) || channelOf(r) === channelOf(s)) return [];
    return [{ row: r, from: channelOf(r), to: channelOf(s) }];
  });
}

const DIFF_LINES = 6;

/** «Use ACQ's alert settings in AUD? 14 alerts change.» con le differenze (shape [A 12]). */
function CopyDialog({
  from,
  to,
  onClose,
}: {
  from: ProjectSubscriptions;
  to: ProjectSubscriptions;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const copy = useCopyAlertSubscriptions();
  const toast = useToast();
  const diff = copyDiff(from, to);
  const ch = (c: Channel) => t(`alerts.copy.channels.${c}`);
  async function confirm() {
    try {
      const done = await copy.mutateAsync({ from: from.projectId, to: to.projectId });
      onClose();
      toast.show(t("alerts.copy.done", { from: from.code, to: to.code }), {
        action: { label: t("alerts.undo"), run: () => void done.undo() },
      });
    } catch {
      toast.error(t("alerts.bulkError", { code: to.code }));
    }
  }
  return (
    <Dialog
      title={t("alerts.copy.title", { from: from.code, to: to.code })}
      description={
        diff.length > 0 ? t("alerts.copy.count", { count: diff.length }) : t("alerts.copy.none")
      }
      width={400}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-md border border-rule-strong px-3 text-sm font-medium text-ink hover:bg-ink/6"
          >
            {t("alerts.copy.cancel")}
          </button>
          <button
            type="button"
            data-autofocus
            disabled={diff.length === 0 || copy.isPending}
            onClick={() => void confirm()}
            className="inline-flex h-8 items-center rounded-md bg-ink px-3 text-sm font-semibold text-ground hover:opacity-90 disabled:opacity-40"
          >
            {t("alerts.copy.confirm")}
          </button>
        </>
      }
    >
      {diff.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-ink">
          {diff.slice(0, DIFF_LINES).map((d) => (
            <li key={d.row.type}>
              {t("alerts.copy.line", { label: t(d.row.labelKey), from: ch(d.from), to: ch(d.to) })}
            </li>
          ))}
          {diff.length > DIFF_LINES && (
            <li className="text-ink-muted">
              {t("alerts.copy.more", { count: diff.length - DIFF_LINES })}
            </li>
          )}
        </ul>
      )}
      <p className="text-sm text-ink-muted">{t("alerts.copy.stays")}</p>
    </Dialog>
  );
}
