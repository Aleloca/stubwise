import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  useArchivedProjects,
  useDepartments,
  usePinnedProjects,
  useProjectPulses,
  useProjects,
  useQueuePause,
  useSetPinned,
  useTasks,
  useWorkspace,
  useWorkspaces,
  workspacesAvailable,
} from "../../data/queries";
import type { Project, ProjectPulse } from "../../data/types";
import { can, useViewer } from "../../data/viewing";
import { inputClass } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { PageEmpty, PageError } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { pulseParts } from "../overview/pulseLine";
import { PulseText } from "../overview/PulseText";
import { Chevron, MenuButton, primaryButton, secondaryButton } from "../tasks/controls";
import { ActivityFeed } from "./ActivityFeed";
import { ArchivedProjects } from "./ArchivedProjects";
import { NewProjectDialog } from "./NewProjectDialog";
import { PeopleActivity, PeopleActivityBar, PeopleActivityForbidden } from "./PeopleActivity";
import { PortfolioStalled } from "./PortfolioStalled";
import { AddProjectsDialog, DeleteWorkspaceDialog, RenameWorkspaceDialog } from "./workspaces/dialogs";
import { WorkspacePeople } from "./workspaces/WorkspacePeople";
import {
  NO_FILTERS,
  filterProjects,
  groupPortfolio,
  hasFilters,
  type PortfolioFilters,
} from "./portfolio";

/**
 * Le schede; «Archived» (area 9c) solo per chi vede almeno un archiviato.
 * «People» solo dentro una workspace (shape `workspaces.md`).
 */
const TABS = ["projects", "stalled", "activity", "archived", "people"] as const;
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
  const search = useSearch({ strict: false }) as { view?: string; workspace?: string };
  // Shape `workspaces.md`: `?workspace=<slug>` filtra la pagina sui progetti
  // della workspace, `none` su quelli fuori da ogni workspace. Nella build app
  // le workspace restano «in arrivo»: il parametro non vale.
  const workspaceSlug = workspacesAvailable() ? search.workspace : undefined;
  const inNone = workspaceSlug === "none";
  const workspaceList = useWorkspaces().data;
  const workspace = useWorkspace(workspaceSlug);
  const [workspaceDialog, setWorkspaceDialog] = useState<"add" | "rename" | "delete" | null>(null);
  // «By person» nella scheda Activity: dall'indirizzo, così un link la apre.
  const personView = search.view === "person";
  const canPeople = can(viewer, "people.activity.view");
  // `?view=stalled`: «open the list» di una risposta di Claude (area 10b, S2).
  const [tab, setTab] = useState<Tab>(
    search.view === "archived"
      ? "archived"
      : search.view === "people" && search.workspace && search.workspace !== "none"
        ? "people"
        : search.view === "stalled"
        ? "stalled"
        : personView
          ? "activity"
          : "projects",
  );
  // «Open Archived» (il toast dopo un'archiviazione) riscrive `?view=archived`
  // con la pagina già aperta.
  useEffect(() => {
    if (search.view === "archived") setTab("archived");
    // Lo stesso per «open the list» di Claude col riquadro aperto su All projects.
    if (search.view === "stalled") setTab("stalled");
  }, [search.view]);
  const archived = useArchivedProjects();
  // Dentro una workspace anche gli archiviati sono i suoi (D6).
  const inScope = useCallback(
    (projectId: string) =>
      !workspaceSlug ||
      (inNone
        ? !workspaceList?.workspaceOfProject[projectId]
        : (workspace.data?.projectIds ?? []).includes(projectId)),
    [workspaceSlug, inNone, workspaceList, workspace.data],
  );
  const archivedRows = (archived.data ?? []).filter((r) => inScope(r.projectId));
  // `?view=archived` per chi non ne vede nessuno apre Projects, senza messaggio.
  const shownTab: Tab =
    (tab === "archived" && archived.isSuccess && archivedRows.length === 0) ||
    (tab === "people" && (!workspaceSlug || inNone))
      ? "projects"
      : tab;
  const tabs = TABS.filter(
    (key) =>
      (key !== "people" || (!!workspaceSlug && !inNone)) &&
      (key !== "archived" || archivedRows.length > 0 || (tab === "archived" && archived.isPending)),
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  // Il fuoco dopo un'archiviazione, un Delete o una riapertura che toglie la
  // riga (shape project-archive.md §6): l'h1, o il titolo della scheda
  // Archived se c'è ancora (altrimenti l'h1), deciso a elenco riletto.
  const [focusTitle, setFocusTitle] = useState(false);
  const arrival = useRouterState({
    select: (s) => (s.location.state as { focus?: string } | undefined)?.focus,
  });
  useEffect(() => {
    if (arrival === "h1") heading.current?.focus({ preventScroll: true });
    if (arrival === "archived") setFocusTitle(true);
  }, [arrival]);
  useEffect(() => {
    if (!focusTitle || archived.isFetching || !archived.isSuccess) return;
    setFocusTitle(false);
    const title = tabsRef.current?.querySelector<HTMLElement>('[data-tab="archived"]');
    if (title && archivedRows.length > 0) title.focus();
    else heading.current?.focus({ preventScroll: true });
  }, [focusTitle, archived.isFetching, archived.isSuccess, archivedRows.length]);
  const onFocusTitle = useCallback(() => setFocusTitle(true), []);
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
  const scoped = useMemo(
    () => (projects.data ?? []).filter((p) => inScope(p.id)),
    [projects.data, inScope],
  );
  const clients = useMemo(
    () =>
      [...new Set(scoped.flatMap((p) => (p.clientName ? [p.clientName] : [])))].sort(
        (a, b) => a.localeCompare(b, i18n.language),
      ),
    [scoped, i18n.language],
  );
  const filtered = useMemo(
    () =>
      filterProjects(
        scoped,
        filters,
        pinnedIds,
        filters.departmentId ? departmentProjectIds : null,
      ),
    [scoped, filters, pinnedIds, departmentProjectIds],
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
  const current = useRef({ togglePin, tab: shownTab, projects: projects.data });
  useEffect(() => {
    current.current = { togglePin, tab: shownTab, projects: projects.data };
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
      tabs[
        (tabs.indexOf(shownTab) + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length
      ]!;
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
  const showPeople = shownTab === "activity" && personView;

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
    (!!filters.departmentId && deptTasks.data === undefined) ||
    (!!workspaceSlug && !inNone && workspace.data === undefined) ||
    (inNone && workspaceList === undefined);
  const failed = [projects, pulses, pinned, deptTasks].filter((q) => q.isError);

  let body;
  if (workspaceSlug && !inNone && workspace.isError) {
    body = (
      <PageEmpty
        title={t("workspaces.page.notFound")}
        action={
          <Link to="/projects" className={secondaryButton}>
            {t("workspaces.page.back")}
          </Link>
        }
      />
    );
  } else if (shownTab === "people" && workspace.data) {
    body = <WorkspacePeople workspace={workspace.data} />;
  } else if (shownTab === "archived") {
    // Gli archiviati non dipendono dai filtri del portafoglio.
    body = (
      <ArchivedProjects
        rows={archived.data ? archivedRows : undefined}
        state={archived.isError ? "error" : archived.isPending ? "loading" : "ready"}
        onRetry={() => void archived.refetch()}
        onFocusTitle={onFocusTitle}
      />
    );
  } else if (showPeople) {
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
  } else if (workspace.data && scoped.length === 0) {
    body = (
      <PageEmpty
        title={t("workspaces.page.empty", { name: workspace.data.name })}
        action={
          workspace.data.canManage ? (
            <button type="button" className={primaryButton} onClick={() => setWorkspaceDialog("add")}>
              {t("workspaces.page.addProjects")}
            </button>
          ) : undefined
        }
      />
    );
  } else if (filtered.length === 0) {
    body = noMatch;
  } else if (shownTab === "projects") {
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
  } else if (shownTab === "stalled") {
    body = <PortfolioStalled projects={filtered} />;
  } else {
    body = <ActivityFeed projects={filtered} />;
  }

  const title = workspace.data
    ? workspace.data.name
    : inNone
      ? t("workspaces.none")
      : t("nav.projects");
  const departmentName = departments?.find((d) => d.id === filters.departmentId)?.name;
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="page-header flex shrink-0 flex-col gap-3 pb-3 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1
            ref={heading}
            tabIndex={-1}
            className="min-w-0 truncate text-2xl font-semibold text-ink outline-none"
          >
            {title}
          </h1>
          {/* Il numero conta gli attivi: sulla scheda Archived lo dice già la scheda. */}
          {!loading && failed.length === 0 && shownTab !== "archived" && (
            <span className="num text-lg text-ink-faint">
              <span aria-hidden="true">{filtered.length}</span>
              <span className="sr-only">{t("projects.count", { count: filtered.length })}</span>
            </span>
          )}
          {workspace.data?.canManage && (
            <span className="ml-auto flex items-center gap-1 self-center">
              <button type="button" className={secondaryButton} onClick={() => setWorkspaceDialog("add")}>
                {t("workspaces.page.addProjects")}
              </button>
              <MenuButton
                label={<span aria-hidden="true">⋯</span>}
                ariaLabel={t("workspaces.page.more", { name: workspace.data.name })}
                className="inline-flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-ink/6"
                menuLabel={t("workspaces.page.more", { name: workspace.data.name })}
                align="right"
              >
                {(close) => (
                  <MenuGroup>
                    <button type="button" role="menuitem" className="w-full px-3 py-1.5 text-left text-sm hover:bg-ink/6" onClick={() => { close(); setWorkspaceDialog("rename"); }}>
                      {t("workspaces.page.rename")}
                    </button>
                    <button type="button" role="menuitem" className="w-full px-3 py-1.5 text-left text-sm text-critical hover:bg-ink/6" onClick={() => { close(); setWorkspaceDialog("delete"); }}>
                      {t("workspaces.page.delete")}
                    </button>
                  </MenuGroup>
                )}
              </MenuButton>
            </span>
          )}
          {canCreate && (
            <button
              type="button"
              className={`${primaryButton} ${workspace.data?.canManage ? "" : "ml-auto"} self-center`}
              onClick={() => setCreating(true)}
            >
              {t("projects.new")}
            </button>
          )}
        </div>
        {workspace.data && (
          <p className="-mt-2 text-sm text-ink-muted" data-workspace-summary>
            {t("workspaces.page.summary", { count: scoped.length })}
            {" · "}
            <button type="button" className="underline" onClick={() => setTab("people")}>
              {t("workspaces.page.people", { count: workspace.data.peopleCount })}
            </button>
          </p>
        )}
        {inNone && <p className="-mt-2 text-sm text-ink-muted">{t("workspaces.page.noneIntro")}</p>}
        {workspace.data && workspaceDialog === "add" && (
          <AddProjectsDialog workspace={workspace.data} onClose={() => setWorkspaceDialog(null)} />
        )}
        {workspace.data && workspaceDialog === "rename" && (
          <RenameWorkspaceDialog workspace={workspace.data} onClose={() => setWorkspaceDialog(null)} />
        )}
        {workspace.data && workspaceDialog === "delete" && (
          <DeleteWorkspaceDialog
            workspace={{ ...workspace.data, projectCount: scoped.length }}
            onClose={() => setWorkspaceDialog(null)}
          />
        )}
        <div
          ref={tabsRef}
          role="tablist"
          aria-label={t("projects.tabs")}
          onKeyDown={onTabKey}
          className="flex gap-1"
        >
          {tabs.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              data-tab={key}
              id={`projects-tab-${key}`}
              aria-selected={shownTab === key}
              aria-controls="projects-panel"
              tabIndex={shownTab === key ? 0 : -1}
              onClick={() => setTab(key)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${shownTab === key ? "bg-ink/10 font-semibold text-ink" : "text-ink-muted hover:bg-ink/6 hover:text-ink"}`}
            >
              {t(`projects.tab.${key}`)}
              {key === "archived" && archivedRows.length > 0 && (
                <span className="num font-normal text-ink-faint">{archivedRows.length}</span>
              )}
            </button>
          ))}
        </div>
        {shownTab !== "archived" && shownTab !== "people" && (
          <div
            role="toolbar"
            aria-label={t(showPeople ? "projects.people.bar" : "projects.filter.label")}
            className="flex flex-wrap items-center gap-x-1 gap-y-2"
          >
            {shownTab === "activity" && canPeople && (
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
        )}
      </header>
      <div
        id="projects-panel"
        role="tabpanel"
        aria-labelledby={`projects-tab-${shownTab}`}
        data-projects-body
        className="min-h-0 flex-1 overflow-auto border-t border-rule px-4 pb-12"
      >
        {body}
      </div>
      {creating && (
        <NewProjectDialog
          workspaceId={workspace.data?.id}
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
