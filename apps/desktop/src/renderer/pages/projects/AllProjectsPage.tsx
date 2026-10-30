import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useDepartments,
  usePinnedProjects,
  useProjectPulses,
  useProjects,
  useQueuePause,
  useSetPinned,
  useTasks,
} from "../../data/queries";
import type { Project, ProjectPulse } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { inputClass } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { PageEmpty, PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { pulseParts } from "../overview/pulseLine";
import { PulseText } from "../overview/PulseText";
import { Chevron, MenuButton, primaryButton, secondaryButton } from "../tasks/controls";
import { ActivityFeed } from "./ActivityFeed";
import { NewProjectDialog } from "./NewProjectDialog";
import { PeopleActivity, PeopleActivityBar, PeopleActivityForbidden } from "./PeopleActivity";
import { PortfolioStalled } from "./PortfolioStalled";
import {
  NO_FILTERS,
  filterProjects,
  groupPortfolio,
  hasFilters,
  type PortfolioFilters,
} from "./portfolio";

const TABS = ["projects", "stalled", "activity"] as const;
type Tab = (typeof TABS)[number];

const OPEN_FAMILIES = ["todo", "active"] as const;

const chipClass =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/8 aria-pressed:bg-ink/10 aria-pressed:text-ink";

/** Si sta scrivendo: la lettera va al campo, non alla pagina. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/**
 * «All projects», il portafoglio (shape overview.md §3b): il catalogo dei
 * progetti visibili, una riga di 44 px per progetto — codice, nome,
 * cliente, modello, riga di polso, fissa/sgancia. Prima il gruppo «Waiting
 * on you», poi tutti gli altri per nome. Tre schede: i progetti, le ferme di
 * tutti i progetti (per progetto, dalla più vecchia) e l'attività per
 * giorno. I filtri (interni/commesse, reparto, cliente, fissati, testo)
 * valgono per tutte e tre. «New project» con `projects.create`.
 *
 * Tastiera: J/K fra le righe, Invio entra nel progetto, P fissa o sgancia.
 */
export function AllProjectsPage() {
  const { t, i18n } = useTranslation();
  const { viewer } = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const projects = useProjects();
  const pulses = useProjectPulses();
  const pinned = usePinnedProjects();
  const departments = useDepartments().data;
  const setPinned = useSetPinned();
  const search = useSearch({ strict: false }) as { view?: string };
  // «By person» nella scheda Activity: dall'indirizzo, così un link la apre.
  const personView = search.view === "person";
  const canPeople = can(viewer, "people.activity.view");
  const [tab, setTab] = useState<Tab>(personView ? "activity" : "projects");
  const [personQuery, setPersonQuery] = useState("");
  // `?view=pinned` (Preferenze → Account, «Manage in All projects»): i soli fissati.
  const [filters, setFilters] = useState<PortfolioFilters>(() =>
    search.view === "pinned" ? { ...NO_FILTERS, pinnedOnly: true } : NO_FILTERS,
  );
  const [creating, setCreating] = useState(false);
  const searchId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const canCreate = can(viewer, "projects.create");

  const deptTasks = useTasks(
    {
      departmentIds: filters.departmentId ? [filters.departmentId] : [],
      families: [...OPEN_FAMILIES],
    },
    { enabled: !!filters.departmentId },
  );
  const departmentProjectIds = useMemo(
    () => (deptTasks.data ? new Set(deptTasks.data.map((x) => x.projectId)) : null),
    [deptTasks.data],
  );
  const pinnedIds = useMemo(() => new Set((pinned.data ?? []).map((p) => p.id)), [pinned.data]);
  const pulseById = useMemo(
    () => new Map((pulses.data ?? []).map((p) => [p.projectId, p])),
    [pulses.data],
  );
  const clients = useMemo(
    () =>
      [...new Set((projects.data ?? []).flatMap((p) => (p.clientName ? [p.clientName] : [])))].sort(
        (a, b) => a.localeCompare(b, i18n.language),
      ),
    [projects.data, i18n.language],
  );
  const filtered = useMemo(
    () =>
      filterProjects(
        projects.data ?? [],
        filters,
        pinnedIds,
        filters.departmentId ? departmentProjectIds : null,
      ),
    [projects.data, filters, pinnedIds, departmentProjectIds],
  );
  const groups = groupPortfolio(filtered, pulseById, i18n.language);
  const set = (patch: Partial<PortfolioFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const togglePin = (project: Project) => {
    const next = !pinnedIds.has(project.id);
    setPinned.mutate(
      { project, pinned: next },
      {
        onError: () =>
          toast.error(
            t(next ? "projects.pinFailed" : "projects.unpinFailed", { code: project.code }),
          ),
      },
    );
  };
  const current = useRef({ togglePin, tab, projects: projects.data });
  useEffect(() => {
    current.current = { togglePin, tab, projects: projects.data };
  });

  // J/K fra le righe, P fissa/sgancia quella col fuoco. Niente scrivendo, né
  // con un dialogo o un menu aperti.
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (typing(e.target) || document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      if (current.current.tab !== "projects") return;
      const key = e.key.toLowerCase();
      const links = [
        ...(listRef.current?.querySelectorAll<HTMLElement>("[data-project-link]") ?? []),
      ];
      const at = links.indexOf(document.activeElement as HTMLElement);
      if (key === "j" || key === "k") {
        const next = at === -1 ? links[0] : links[key === "j" ? at + 1 : at - 1];
        if (!next) return;
        e.preventDefault();
        next.focus();
        next.scrollIntoView?.({ block: "nearest" });
      } else if (key === "p") {
        const code = (document.activeElement as HTMLElement | null)
          ?.closest("[data-project-row]")
          ?.getAttribute("data-project-row");
        const project = current.current.projects?.find((p) => p.code === code);
        if (!project) return;
        e.preventDefault();
        current.current.togglePin(project);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next =
      TABS[(TABS.indexOf(tab) + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
    setTab(next);
    (e.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus();
  };

  const setView = (view: "project" | "person") =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) =>
        view === "person"
          ? { ...prev, view: "person" }
          : { ...prev, view: undefined, date: undefined, dept: undefined },
      replace: true,
    } as never);
  const showPeople = tab === "activity" && personView;

  const clear = () => setFilters(NO_FILTERS);
  const noMatch = (
    <PageEmpty
      title={t("projects.states.noMatchTitle")}
      body={t("projects.states.noMatchBody")}
      action={
        <button type="button" className={secondaryButton} onClick={clear}>
          {t("projects.states.clear")}
        </button>
      }
    />
  );

  const loading =
    projects.data === undefined ||
    pulses.data === undefined ||
    pinned.data === undefined ||
    (!!filters.departmentId && deptTasks.data === undefined);
  const failed = [projects, pulses, pinned, deptTasks].filter((q) => q.isError);

  let body;
  if (showPeople) {
    // La rassegna per persona non dipende dai filtri del portafoglio: ha i suoi.
    body = canPeople ? (
      <PeopleActivity query={personQuery} onClearQuery={() => setPersonQuery("")} />
    ) : (
      <PeopleActivityForbidden onByProject={() => setView("project")} />
    );
  } else if (failed.length > 0) {
    body = (
      <PageError
        message={t("projects.states.error")}
        onRetry={() => {
          for (const q of failed) void q.refetch();
        }}
      />
    );
  } else if (loading) {
    body = <ProjectSkeleton />;
  } else if (projects.data!.length === 0) {
    body = (
      <PageEmpty
        title={t("projects.states.emptyTitle")}
        body={canCreate ? t("projects.states.emptyBody") : t("projects.states.emptyWho")}
        action={
          canCreate ? (
            <button type="button" className={primaryButton} onClick={() => setCreating(true)}>
              {t("projects.new")}
            </button>
          ) : undefined
        }
      />
    );
  } else if (filtered.length === 0) {
    body = noMatch;
  } else if (tab === "projects") {
    body = (
      <div ref={listRef}>
        {(
          [
            ["waiting", groups.waiting],
            ["all", groups.rest],
          ] as const
        ).map(([key, rows]) =>
          rows.length === 0 ? null : (
            <section key={key} aria-labelledby={`projects-${key}`}>
              <h2
                id={`projects-${key}`}
                className="heading-group flex h-9 items-end gap-2 pb-2 pl-4"
              >
                <span className="min-w-0 truncate">{t(`projects.groups.${key}`)}</span>
                <span className="num font-normal tracking-normal text-ink-faint">
                  {rows.length}
                </span>
              </h2>
              <ul aria-label={t(`projects.groups.${key}`)} className="border-t border-rule">
                {rows.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    pulse={pulseById.get(p.id)}
                    pinned={pinnedIds.has(p.id)}
                    onTogglePin={() => togglePin(p)}
                  />
                ))}
              </ul>
            </section>
          ),
        )}
      </div>
    );
  } else if (tab === "stalled") {
    body = <PortfolioStalled projects={filtered} />;
  } else {
    body = <ActivityFeed projects={filtered} />;
  }

  const title = t("nav.projects");
  const departmentName = departments?.find((d) => d.id === filters.departmentId)?.name;
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="page-header flex shrink-0 flex-col gap-3 pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="min-w-0 truncate text-2xl font-semibold text-ink">{title}</h1>
          {!loading && failed.length === 0 && (
            <span className="num text-lg text-ink-faint">
              <span aria-hidden="true">{filtered.length}</span>
              <span className="sr-only">{t("projects.count", { count: filtered.length })}</span>
            </span>
          )}
          {canCreate && (
            <button
              type="button"
              className={`${primaryButton} ml-auto self-center`}
              onClick={() => setCreating(true)}
            >
              {t("projects.new")}
            </button>
          )}
        </div>
        <div
          role="tablist"
          aria-label={t("projects.tabs")}
          onKeyDown={onTabKey}
          className="flex gap-1"
        >
          {TABS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              data-tab={key}
              id={`projects-tab-${key}`}
              aria-selected={tab === key}
              aria-controls="projects-panel"
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              className={`inline-flex h-8 items-center rounded-md px-3 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${tab === key ? "bg-ink/10 font-semibold text-ink" : "text-ink-muted hover:bg-ink/6 hover:text-ink"}`}
            >
              {t(`projects.tab.${key}`)}
            </button>
          ))}
        </div>
        <div
          role="toolbar"
          aria-label={t(showPeople ? "projects.people.bar" : "projects.filter.label")}
          className="flex flex-wrap items-center gap-x-1 gap-y-2"
        >
          {tab === "activity" && canPeople && (
            <ActivityViewSwitch view={personView ? "person" : "project"} onChange={setView} />
          )}
          {showPeople ? (
            canPeople && <PeopleActivityBar query={personQuery} onQuery={setPersonQuery} />
          ) : (
            <>
              <label htmlFor={searchId} className="sr-only">
                {t("projects.filter.search")}
              </label>
              <span className="mr-2 flex w-52 min-w-0 min-[1280px]:w-60">
                <input
                  id={searchId}
                  type="search"
                  value={filters.text}
                  placeholder={t("projects.filter.search")}
                  onChange={(e) => set({ text: e.target.value })}
                  className={`${inputClass} h-8 py-0 text-sm`}
                />
              </span>
              <MenuButton
                menuLabel={t("projects.filter.kind")}
                className={chipClass}
                label={
                  <>
                    <span>{t("projects.filter.kind")}:</span>
                    <span className="font-medium text-ink">
                      {t(`projects.filter.kinds.${filters.kind}`)}
                    </span>
                    <Chevron />
                  </>
                }
              >
                {(close) => (
                  <MenuGroup>
                    {(["all", "internal", "client"] as const).map((k) => (
                      <RadioItem
                        key={k}
                        checked={filters.kind === k}
                        onSelect={() => {
                          close();
                          set({ kind: k });
                        }}
                      >
                        {t(`projects.filter.kinds.${k}`)}
                      </RadioItem>
                    ))}
                  </MenuGroup>
                )}
              </MenuButton>
              <MenuButton
                menuLabel={t("projects.filter.department")}
                className={chipClass}
                title={t("projects.filter.departmentHint")}
                label={
                  <>
                    <span>{t("projects.filter.department")}:</span>
                    <span className="max-w-40 truncate font-medium text-ink">
                      {departmentName ?? t("projects.filter.any")}
                    </span>
                    <Chevron />
                  </>
                }
              >
                {(close) => (
                  <MenuGroup label={t("projects.filter.departmentHint")}>
                    {[null, ...(departments ?? []).map((d) => d.id)].map((id) => (
                      <RadioItem
                        key={id ?? "any"}
                        checked={filters.departmentId === id}
                        onSelect={() => {
                          close();
                          set({ departmentId: id });
                        }}
                      >
                        {id
                          ? departments!.find((d) => d.id === id)!.name
                          : t("projects.filter.any")}
                      </RadioItem>
                    ))}
                  </MenuGroup>
                )}
              </MenuButton>
              <MenuButton
                menuLabel={t("projects.filter.client")}
                className={chipClass}
                label={
                  <>
                    <span>{t("projects.filter.client")}:</span>
                    <span className="max-w-48 truncate font-medium text-ink">
                      {filters.clientName ?? t("projects.filter.any")}
                    </span>
                    <Chevron />
                  </>
                }
              >
                {(close) => (
                  <MenuGroup>
                    {[null, ...clients].map((c) => (
                      <RadioItem
                        key={c ?? "any"}
                        checked={filters.clientName === c}
                        onSelect={() => {
                          close();
                          set({ clientName: c });
                        }}
                      >
                        <span className="min-w-0 truncate">{c ?? t("projects.filter.any")}</span>
                      </RadioItem>
                    ))}
                  </MenuGroup>
                )}
              </MenuButton>
              <button
                type="button"
                aria-pressed={filters.pinnedOnly}
                className={chipClass}
                onClick={() => set({ pinnedOnly: !filters.pinnedOnly })}
              >
                <PinIcon filled={filters.pinnedOnly} />
                {t("projects.filter.pinned")}
              </button>
              {hasFilters(filters) && (
                <button type="button" className={chipClass} onClick={clear}>
                  {t("projects.states.clear")}
                </button>
              )}
            </>
          )}
        </div>
      </header>
      <div
        id="projects-panel"
        role="tabpanel"
        aria-labelledby={`projects-tab-${tab}`}
        data-projects-body
        className="min-h-0 flex-1 overflow-auto border-t border-rule px-4 pb-12"
      >
        {body}
      </div>
      {creating && (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(code) => {
            setCreating(false);
            void navigate({ to: "/p/$code/$section", params: { code, section: "overview" } });
          }}
        />
      )}
    </section>
  );
}

/**
 * Il segmentato della scheda Activity: «By project» (l'attività per giorno)
 * e «By person» (la rassegna), il secondo solo con `people.activity.view`.
 */
function ActivityViewSwitch({
  view,
  onChange,
}: {
  view: "project" | "person";
  onChange: (view: "project" | "person") => void;
}) {
  const { t } = useTranslation();
  const views = ["project", "person"] as const;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = view === "project" ? "person" : "project";
    onChange(next);
    (e.currentTarget.querySelector(`[data-view="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={t("projects.people.views")}
      onKeyDown={onKey}
      className="mr-3 flex h-8 items-center gap-0.5 rounded-md border border-rule p-0.5"
    >
      {views.map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          data-view={v}
          aria-checked={view === v}
          tabIndex={view === v ? 0 : -1}
          onClick={() => onChange(v)}
          className={`inline-flex h-full items-center rounded-[4px] px-2.5 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${view === v ? "bg-ink/10 font-semibold text-ink" : "text-ink-muted hover:bg-ink/6 hover:text-ink"}`}
        >
          {t(`projects.people.view.${v}`)}
        </button>
      ))}
    </div>
  );
}

const TEMPLATE_KEYS = {
  software: "projects.templates.software",
  marketing: "projects.templates.marketing",
  client: "projects.templates.client",
  empty: "projects.templates.empty",
} as const;

/**
 * Un progetto: codice in cifre tabellari · nome (link all'Overview) ·
 * cliente · modello · riga di polso · fissa/sgancia. Niente striscia del
 * reparto: il reparto è delle task, non dei progetti. Stretta, la riga
 * lascia prima il modello, poi il cliente (resta nel `title`), poi il
 * traguardo del polso — «3 stalled» resta.
 */
function ProjectRow({
  project,
  pulse,
  pinned,
  onTogglePin,
}: {
  project: Project;
  pulse: ProjectPulse | undefined;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const { t, i18n } = useTranslation();
  const parts = pulse ? pulseParts(pulse, t, i18n.language) : [];
  const template = t(TEMPLATE_KEYS[project.template]);
  const client = project.clientName ?? t("projects.internal");
  return (
    <li
      data-project-row={project.code}
      title={`${project.name} · ${client} · ${template}`}
      className="@container relative border-b border-rule transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 has-[[data-project-link]:focus-visible]:outline-2 has-[[data-project-link]:focus-visible]:-outline-offset-2 has-[[data-project-link]:focus-visible]:outline-focus"
    >
      <div className="flex min-h-11 items-center gap-4 py-1 pr-2 pl-4">
        <Link
          to="/p/$code/$section"
          params={{ code: project.code, section: "overview" }}
          data-project-link
          className="flex min-w-0 flex-[1_1_0%] items-baseline gap-3 outline-none after:absolute after:inset-0"
        >
          <span className="num w-10 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
            {project.code}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="min-w-0 truncate text-md font-medium text-ink">{project.name}</span>
            <QueuePausedNote projectId={project.id} />
          </span>
          <span className="sr-only">
            {" · "}
            {client}
          </span>
        </Link>
        <span
          aria-hidden="true"
          className="w-[160px] shrink-0 truncate text-sm text-ink-muted @max-[760px]:hidden"
        >
          {project.clientName ?? <span className="text-ink-faint">{t("projects.internal")}</span>}
        </span>
        <span
          aria-hidden="true"
          className="w-[112px] shrink-0 truncate text-sm text-ink-muted @max-[900px]:hidden"
        >
          {template}
        </span>
        <span
          data-pulse-line
          title={parts.map((p) => p.text).join(" · ")}
          className="@container/pulse relative flex min-w-0 flex-[1.3_1_0%] items-center gap-2 overflow-hidden text-sm whitespace-nowrap text-ink-muted"
        >
          <PulseSign pulse={pulse} />
          <span className="min-w-0 truncate">
            <PulseText
              parts={parts}
              projectCode={project.code}
              partClassName={(part) =>
                part.kind === "next" && parts.length > 1 ? "@max-[340px]/pulse:hidden" : ""
              }
            />
          </span>
        </span>
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={t(pinned ? "projects.unpin" : "projects.pin", { code: project.code })}
          title={t(pinned ? "projects.unpin" : "projects.pin", { code: project.code })}
          onClick={onTogglePin}
          className={`relative grid size-8 shrink-0 place-items-center rounded-md transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink ${pinned ? "text-ink" : "text-ink-faint"}`}
        >
          <PinIcon filled={pinned} />
        </button>
      </div>
    </li>
  );
}

/**
 * La coda del progetto in pausa (area 9b, shape instance-effects [EF 4],
 * confermata dal maintainer): «‖ Queue paused» sulla seconda linea, sotto il
 * nome. Chi l'ha messa e il «Who?» stanno nella testata del progetto.
 */
function QueuePausedNote({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  // La sola pausa: col budget raggiunto si legge lo stesso (shape [EF 4]).
  const pause = useQueuePause(projectId).data;
  if (!pause) return null;
  return (
    <span data-queue-paused className="flex gap-1.5 text-xs text-ink-muted">
      <span aria-hidden="true">‖</span>
      {t("instanceEffects.queue.row")}
    </span>
  );
}

/**
 * Il segno davanti al polso, come sulle tessere del binario: punto pieno
 * d'inchiostro per «aspetta te», anello tratteggiato per «Claude ci lavora».
 * Il testo accanto dice la stessa cosa: il segno non è mai l'unico.
 */
function PulseSign({ pulse }: { pulse: ProjectPulse | undefined }) {
  if (pulse?.waitingOnMe) {
    return <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ink" />;
  }
  if (pulse?.claudeWorking) {
    return (
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full border-[1.5px] border-dashed border-ink"
      />
    );
  }
  return <span aria-hidden="true" className="size-2 shrink-0" />;
}

export function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M6 2.5h4l-.5 4 2.5 2.5H4L6.5 6.5z" />
      <path d="M8 9v4.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

const bar = "rounded-sm bg-ink/8";
const NAME_WIDTHS = ["52%", "40%", "64%", "46%", "58%", "36%", "61%", "44%"];

/** Caricamento con la forma vera della riga di un progetto (niente striscia). */
function ProjectSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="skeleton-breathe pt-9">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      <div className="border-t border-rule">
        {NAME_WIDTHS.map((w, i) => (
          <div
            key={i}
            data-skeleton-row
            className="@container flex h-11 items-center gap-4 border-b border-rule pr-2 pl-4"
          >
            <span className="flex min-w-0 flex-[1_1_0%] items-center gap-3">
              <span className={`h-2.5 w-8 shrink-0 ${bar}`} />
              <span className={`h-2.5 ${bar}`} style={{ width: w }} />
            </span>
            <span className={`h-2.5 w-[120px] shrink-0 ${bar} @max-[760px]:hidden`} />
            <span className={`h-2.5 w-[64px] shrink-0 ${bar} @max-[900px]:hidden`} />
            <span className="min-w-0 flex-[1.3_1_0%]">
              <span className={`block h-2.5 w-3/5 ${bar}`} />
            </span>
            <span className="size-4 shrink-0 rounded-sm bg-ink/8" />
          </div>
        ))}
      </div>
    </div>
  );
}
