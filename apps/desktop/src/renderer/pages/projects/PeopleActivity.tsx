import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../data/dates";
import {
  useDailyReports,
  useDepartments,
  useGenerateDailyReport,
  useLinkCommitAuthor,
  usePeople,
  usePeopleActivity,
  useProjects,
  useTasks,
} from "../../data/queries";
import type {
  CommitOfDay,
  DailyReportView,
  Person,
  PersonDayActivity,
  Project,
} from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { DeptLegend, DeptStrip, useDeptLabel } from "../../layout/DeptStrip";
import { inputClass } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem, itemClass } from "../../tasks-ui/Menu";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { Avatar } from "../../tasks-ui/PersonChip";
import { useToast } from "../../tasks-ui/Toast";
import { useOpenTask } from "../home/blocks/BlockSection";
import { GeneratedTag } from "../overview/BriefCard";
import { shiftDate } from "../overview/links";
import { ghostButton } from "../task/parts";
import { Chevron, MenuButton, secondaryButton } from "../tasks/controls";

// La rassegna del giorno per persona (All projects → Activity → By person,
// shape people-activity.md): chi coordina rivede cosa ha fatto ogni persona,
// in ogni reparto. Un registro, non una classifica: le persone stanno per
// reparto e in ordine alfabetico, la sintesi dice solo ciò che non è zero.

const chipClass =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/8";

const iconButton =
  "grid size-8 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink disabled:pointer-events-none disabled:text-ink-faint/60";

/** Si sta scrivendo: la lettera va al campo, non alla pagina. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/**
 * Giorno e reparto della rassegna, nell'indirizzo (`?view=person&date=…&dept=…`).
 * Oggi non si scrive; un giorno dal link oltre oggi vale oggi (niente futuro).
 */
export function useReviewSearch() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { date?: string; dept?: string };
  const date = search.date && search.date < TODAY ? search.date : TODAY;
  const departmentId = search.dept ?? null;
  const patch = (next: Record<string, string | undefined>) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, ...next }),
      replace: true,
    } as never);
  return {
    date,
    departmentId,
    setDate: (d: string) => patch({ date: d >= TODAY ? undefined : d }),
    setDepartment: (id: string | null) => patch({ dept: id ?? undefined }),
  };
}

/** «Fri, Oct 23» nella lingua dell'app: il giorno è una data, non un istante. */
function dayText(date: string, language: string, weekday: "short" | "long" = "short"): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(language, {
    weekday,
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** L'ora locale di un istante, in cifre tabellari. */
function timeText(at: string, language: string): string {
  return new Date(at).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
}

/**
 * La barra della rassegna: ‹ giorno ›, reparto, ricerca di una persona.
 * `[` e `]` cambiano giorno (li ascolta la rassegna); un clic sul giorno apre
 * il calendario del sistema; «Today» torna a oggi.
 */
export function PeopleActivityBar({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (q: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const departments = useDepartments().data;
  const { date, departmentId, setDate, setDepartment } = useReviewSearch();
  const picker = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const label =
    date === TODAY
      ? t("projects.people.dayToday", { date: dayText(date, i18n.language) })
      : date === shiftDate(TODAY, -1)
        ? t("projects.people.dayYesterday", { date: dayText(date, i18n.language) })
        : dayText(date, i18n.language);
  const openPicker = () => {
    const el = picker.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };
  const departmentName = departments?.find((d) => d.id === departmentId)?.name;
  return (
    <>
      <span
        role="group"
        aria-label={t("projects.people.bar")}
        title={t("projects.people.keysHint")}
        className="relative mr-2 flex items-center"
      >
        <button
          type="button"
          aria-label={t("projects.people.previousDay")}
          title={`${t("projects.people.previousDay")} ([)`}
          onClick={() => setDate(shiftDate(date, -1))}
          className={iconButton}
        >
          <Arrow dir="left" />
        </button>
        <button
          type="button"
          aria-label={`${label} · ${t("projects.people.pickDay")}`}
          onClick={openPicker}
          className="num inline-flex h-8 min-w-[9.5rem] items-center justify-center rounded-md px-2 text-sm font-medium whitespace-nowrap text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
        >
          {label}
        </button>
        <button
          type="button"
          aria-label={t("projects.people.nextDay")}
          title={`${t("projects.people.nextDay")} (])`}
          disabled={date >= TODAY}
          onClick={() => setDate(shiftDate(date, 1))}
          className={iconButton}
        >
          <Arrow dir="right" />
        </button>
        {date !== TODAY && (
          <button type="button" className={`${chipClass} ml-1`} onClick={() => setDate(TODAY)}>
            {t("projects.people.backToToday")}
          </button>
        )}
        <input
          ref={picker}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          max={TODAY}
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="pointer-events-none absolute bottom-0 left-10 h-0 w-0 opacity-0"
        />
      </span>
      <MenuButton
        menuLabel={t("projects.people.department")}
        className={chipClass}
        label={
          <>
            <span>{t("projects.people.department")}:</span>
            <span className="max-w-40 truncate font-medium text-ink">
              {departmentName ?? t("projects.people.any")}
            </span>
            <Chevron />
          </>
        }
      >
        {(close) => (
          <MenuGroup>
            {[null, ...(departments ?? []).map((d) => d.id)].map((id) => (
              <RadioItem
                key={id ?? "any"}
                checked={departmentId === id}
                onSelect={() => {
                  close();
                  setDepartment(id);
                }}
              >
                {id ? departments!.find((d) => d.id === id)!.name : t("projects.people.any")}
              </RadioItem>
            ))}
          </MenuGroup>
        )}
      </MenuButton>
      <label htmlFor={searchId} className="sr-only">
        {t("projects.people.search")}
      </label>
      <span className="ml-1 flex w-48 min-w-0 min-[1280px]:w-56">
        <input
          id={searchId}
          type="search"
          value={query}
          placeholder={t("projects.people.search")}
          onChange={(e) => onQuery(e.target.value)}
          className={`${inputClass} h-8 py-0 text-sm`}
        />
      </span>
    </>
  );
}

function Arrow({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={dir === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} />
    </svg>
  );
}

type ReportState = "ready" | "failed" | "missing" | "generating";

/** Lo stato del report di un progetto e il modo di (ri)generarlo. */
interface Reports {
  stateOf: (projectId: string) => ReportState;
  /** I commit del giorno arrivati dopo che il report è stato scritto (0: nessun avviso). */
  newCommitsOf: (projectId: string) => number;
  canGenerate: boolean;
  generate: (projectIds: string[]) => void;
}

/** Il primo nell'ordine conta: chi guarda vede prima ciò che sta succedendo o va sistemato. */
const REPORT_ORDER: ReportState[] = ["generating", "failed", "missing", "ready"];

const CATEGORIES = ["closed", "moved", "comments", "decisions", "requests", "commits"] as const;
type Category = (typeof CATEGORIES)[number];

const countsOf = (p: PersonDayActivity): Record<Category, number> => ({
  closed: p.tasksClosed.length,
  moved: p.tasksMoved.length,
  comments: p.comments.length,
  decisions: p.decisions.length,
  requests: p.requestsCreated.length,
  commits: p.commits.length,
});

const keyOf = (p: PersonDayActivity) => p.personId ?? `unlinked:${p.name}`;

/**
 * Il corpo della rassegna: per reparto (nell'ordine configurato, il listello
 * del reparto come legenda della testata), una riga di sintesi per persona
 * che si apre sulle sei categorie; in coda gli autori di commit non collegati
 * e chi non ha attività. Una persona in più reparti sta sotto il primo.
 */
export function PeopleActivity({
  query,
  onClearQuery,
}: {
  query: string;
  onClearQuery: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { viewer } = useViewer();
  const toast = useToast();
  const { date, departmentId, setDate, setDepartment } = useReviewSearch();
  const activity = usePeopleActivity(date, departmentId ?? undefined);
  const reports = useDailyReports(date);
  const people = usePeople();
  const departments = useDepartments();
  const projects = useProjects();
  const generateReport = useGenerateDailyReport();
  const [generating, setGenerating] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const canGenerate = can(viewer, "settings.manage");

  // `[` e `]` cambiano giorno, J/K passano fra le persone. Niente scrivendo,
  // né con un dialogo o un menu aperti.
  const current = useRef({ date, setDate });
  useEffect(() => {
    current.current = { date, setDate };
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
      if (typing(e.target) || document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      const { date: day, setDate: go } = current.current;
      if (e.key === "[") {
        e.preventDefault();
        go(shiftDate(day, -1));
      } else if (e.key === "]") {
        if (day >= TODAY) return;
        e.preventDefault();
        go(shiftDate(day, 1));
      } else if (!e.shiftKey && (e.key === "j" || e.key === "k")) {
        const toggles = [
          ...(listRef.current?.querySelectorAll<HTMLElement>("[data-person-toggle]") ?? []),
        ];
        const at = toggles.indexOf(document.activeElement as HTMLElement);
        const next = at === -1 ? toggles[0] : toggles[e.key === "j" ? at + 1 : at - 1];
        if (!next) return;
        e.preventDefault();
        next.focus();
        next.scrollIntoView?.({ block: "nearest" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const byProjectId = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p])),
    [projects.data],
  );
  const reportsApi: Reports = useMemo(() => {
    const byProject = new Map<string, DailyReportView>(
      (reports.data ?? []).map((r) => [r.projectId, r]),
    );
    return {
      canGenerate,
      stateOf: (projectId) => {
        if (generating.has(projectId)) return "generating";
        const report = byProject.get(projectId);
        if (!report) return "missing";
        return report.summary === null ? "failed" : "ready";
      },
      newCommitsOf: (projectId) =>
        generating.has(projectId) ? 0 : (byProject.get(projectId)?.newCommits ?? 0),
      generate: (projectIds) => {
        setGenerating((s) => new Set([...s, ...projectIds]));
        for (const projectId of projectIds) {
          generateReport.mutate(
            { projectId, date },
            {
              onError: () =>
                toast.error(
                  t("projects.people.report.generateFailed", {
                    code: byProjectId.get(projectId)?.code ?? "",
                  }),
                ),
              onSettled: () =>
                setGenerating((s) => new Set([...s].filter((id) => id !== projectId))),
            },
          );
        }
      },
    };
    // `generateReport.mutate` è stabile; `t` e `toast` cambiano solo con la lingua.
  }, [reports.data, generating, canGenerate, date, byProjectId, t]);

  const queries = [activity, reports, people, departments, projects];
  const failed = queries.filter((q) => q.isError);
  if (failed.length > 0) {
    return (
      <PageError
        message={t("projects.people.states.error")}
        onRetry={() => {
          for (const q of failed) void q.refetch();
        }}
      />
    );
  }
  if (queries.some((q) => q.data === undefined)) return <PageSkeleton rows={8} />;

  const needle = query.trim().toLowerCase();
  const matches = (name: string) => !needle || name.toLowerCase().includes(needle);
  const rows = activity.data!.filter((p) => matches(p.name));
  const linked = rows.filter((p) => p.personId !== null);
  const unlinked = rows.filter((p) => p.personId === null);
  const active = new Set(linked.map((p) => p.personId));
  const quiet = people.data!.filter(
    (p) =>
      !p.isClaude &&
      !active.has(p.id) &&
      matches(p.name) &&
      (!departmentId || p.departmentIds.includes(departmentId)),
  );
  const personById = new Map(people.data!.map((p) => [p.id, p]));

  if (rows.length === 0) {
    if (needle || departmentId) {
      return (
        <PageEmpty
          title={t("projects.people.states.noMatchTitle")}
          body={t("projects.people.states.noMatchBody")}
          action={
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                onClearQuery();
                setDepartment(null);
              }}
            >
              {t("projects.people.states.clear")}
            </button>
          }
        />
      );
    }
    return (
      <PageEmpty
        title={t("projects.people.states.emptyTitle", {
          date: dayText(date, i18n.language, "long"),
        })}
        body={t("projects.people.states.emptyBody")}
        action={
          <button
            type="button"
            className={secondaryButton}
            onClick={() => setDate(shiftDate(date, -1))}
          >
            {t("projects.people.previousDay")}
          </button>
        }
      />
    );
  }

  const groups: {
    id: string;
    name: string;
    colorToken: string | null;
    rows: PersonDayActivity[];
  }[] = [];
  for (const d of departments.data!) {
    const inDept = linked.filter((p) => p.departmentIds[0] === d.id);
    if (inDept.length > 0) {
      groups.push({ id: d.id, name: d.name, colorToken: d.colorToken, rows: inDept });
    }
  }
  const homeless = linked.filter(
    (p) => !departments.data!.some((d) => d.id === p.departmentIds[0]),
  );
  if (homeless.length > 0) {
    groups.push({
      id: "none",
      name: t("projects.people.noDepartment"),
      colorToken: null,
      rows: homeless,
    });
  }
  const allKeys = rows.map(keyOf);
  const allOpen = allKeys.every((k) => open.has(k));
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const expandAll = (
    <button
      type="button"
      className={`${ghostButton} ml-auto`}
      onClick={() => setOpen(allOpen ? new Set() : new Set(allKeys))}
    >
      {t(allOpen ? "projects.people.collapseAll" : "projects.people.expandAll")}
    </button>
  );
  // La legenda dei listelli delle task, solo se una persona aperta ne mostra.
  const openTaskDepts = rows
    .filter((p) => open.has(keyOf(p)))
    .flatMap((p) => [...p.tasksClosed, ...p.tasksMoved, ...p.comments].map((x) => x.taskId));

  return (
    <div ref={listRef} data-people-activity={date}>
      <TaskDeptLegend taskIds={openTaskDepts} />
      {groups.map((g, i) => (
        <section key={g.id} aria-labelledby={`people-${g.id}`} data-people-group={g.id}>
          <h2 id={`people-${g.id}`} className="flex h-11 items-end gap-2 pr-1 pb-2 pl-4">
            {g.colorToken && (
              <span
                aria-hidden="true"
                className="mb-[2px] h-3 w-[3px] shrink-0 rounded-[1px]"
                style={{ background: `var(${g.colorToken})` }}
              />
            )}
            <span className="heading-group">{g.name}</span>
            <span className="num text-xs text-ink-faint">{g.rows.length}</span>
            {i === 0 && expandAll}
          </h2>
          <ul aria-label={`${g.name} ${g.rows.length}`} className="border-t border-rule">
            {g.rows.map((p) => (
              <PersonRow
                key={keyOf(p)}
                activity={p}
                person={personById.get(p.personId!)}
                open={open.has(keyOf(p))}
                onToggle={() => toggle(keyOf(p))}
                reports={reportsApi}
                projects={byProjectId}
              />
            ))}
          </ul>
        </section>
      ))}
      {unlinked.length > 0 && (
        <UnlinkedGroup
          rows={unlinked}
          people={people.data!}
          open={open}
          onToggle={toggle}
          reports={reportsApi}
          projects={byProjectId}
          expandAll={groups.length === 0 ? expandAll : null}
        />
      )}
      {quiet.length > 0 && (
        <section aria-labelledby="people-quiet" data-people-quiet className="pt-2">
          <h2 id="people-quiet" className="flex h-11 items-end gap-2 pb-2 pl-4">
            <span className="heading-group">{t("projects.people.noActivity")}</span>
            <span className="num text-xs text-ink-faint">{quiet.length}</span>
          </h2>
          <p className="border-t border-rule py-3 pr-3 pl-4 text-sm text-ink-muted">
            {quiet.map((p) => p.name).join(" · ")}
          </p>
        </section>
      )}
    </div>
  );
}

/** La legenda dei reparti delle task mostrate (le righe aperte portano il listello). */
function TaskDeptLegend({ taskIds }: { taskIds: string[] }) {
  const tasks = useTasks();
  if (taskIds.length === 0 || !tasks.data) return null;
  const wanted = new Set(taskIds);
  const ids = tasks.data.filter((x) => wanted.has(x.id)).map((x) => x.departmentId);
  return (
    <div className="flex h-9 items-center pl-4">
      <DeptLegend departmentIds={ids} />
    </div>
  );
}

/** «2 closed · 5 moved · 1 decision»: solo le voci che non sono zero. */
function summaryOf(p: PersonDayActivity, t: (k: string, o?: Record<string, unknown>) => string) {
  const counts = countsOf(p);
  return CATEGORIES.filter((c) => counts[c] > 0)
    .map((c) => t(`projects.people.summary.${c}`, { count: counts[c] }))
    .join(" · ");
}

/** I progetti dei commit di una persona, nell'ordine in cui compaiono. */
const commitProjects = (commits: CommitOfDay[]) => [...new Set(commits.map((c) => c.projectId))];

/**
 * Una persona: chevron · iniziali · nome · sintesi, e lo stato del report per
 * chi ha commit. Tutta la riga apre e chiude (Invio, clic); aperta, le sei
 * categorie in ordine fisso.
 */
function PersonRow({
  activity,
  person,
  open,
  onToggle,
  reports,
  projects,
}: {
  activity: PersonDayActivity;
  person: Person | undefined;
  open: boolean;
  onToggle: () => void;
  reports: Reports;
  projects: Map<string, Project>;
}) {
  const { t } = useTranslation();
  const detailId = useId();
  const summary = summaryOf(activity, t);
  const projectIds = commitProjects(activity.commits);
  return (
    <li data-person-row={activity.personId} className="@container relative border-b border-rule">
      <div className="relative flex min-h-11 items-center gap-3 pr-3 pl-2 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 has-[[data-person-toggle]:focus-visible]:outline-2 has-[[data-person-toggle]:focus-visible]:-outline-offset-2 has-[[data-person-toggle]:focus-visible]:outline-focus">
        <button
          type="button"
          data-person-toggle
          aria-expanded={open}
          aria-controls={detailId}
          onClick={onToggle}
          className="grid min-w-0 flex-1 grid-cols-[16px_22px_minmax(0,11rem)_minmax(0,1fr)] items-center gap-x-2.5 py-1.5 text-left outline-none after:absolute after:inset-0 @max-[620px]:grid-cols-[16px_22px_minmax(0,1fr)]"
        >
          <Disclosure open={open} />
          <Avatar person={person} />
          <span className="min-w-0 truncate text-md font-medium text-ink">{activity.name}</span>
          <span
            title={summary}
            className="num min-w-0 truncate text-sm text-ink-muted @max-[620px]:col-start-3"
          >
            {summary}
          </span>
        </button>
        {projectIds.length > 0 && !open && (
          <span className="relative shrink-0 @max-[760px]:hidden">
            <ReportCell projectIds={projectIds} reports={reports} projects={projects} />
          </span>
        )}
      </div>
      {open && (
        <div id={detailId}>
          <PersonDetail activity={activity} reports={reports} projects={projects} />
        </div>
      )}
    </li>
  );
}

function Disclosure({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`text-ink-faint transition-transform duration-[var(--duration-fast)] ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/**
 * Lo stato del report per un insieme di progetti (la riga della persona, o
 * un repository dei suoi commit): pronto, in generazione (l'anello di
 * Claude), non generato o non riuscito — con «Generate report»/«Retry» per
 * chi ha il permesso di oggi, «Open» quando è pronto per un progetto solo.
 */
function ReportCell({
  projectIds,
  reports,
  projects,
}: {
  projectIds: string[];
  reports: Reports;
  projects: Map<string, Project>;
}) {
  const { t } = useTranslation();
  const states = projectIds.map((id) => reports.stateOf(id));
  const state = REPORT_ORDER.find((s) => states.includes(s))!;
  const todo = projectIds.filter((id) => {
    const s = reports.stateOf(id);
    return s === "missing" || s === "failed";
  });
  const single = projectIds.length === 1 ? projects.get(projectIds[0]!) : undefined;
  // Un report scritto prima degli ultimi commit del giorno: lo dice, e si rigenera.
  const stale = projectIds.filter((id) => reports.newCommitsOf(id) > 0);
  const newCommits = stale.reduce((sum, id) => sum + reports.newCommitsOf(id), 0);
  return (
    <span className="flex items-center gap-1 text-sm whitespace-nowrap" data-report-state={state}>
      {state === "generating" && (
        <span
          aria-hidden="true"
          className="rail-pulse mr-1 size-2.5 shrink-0 rounded-full border-[1.5px] border-dashed border-ink"
        />
      )}
      <span
        role={state === "generating" ? "status" : undefined}
        title={
          !reports.canGenerate && state !== "ready" ? t("projects.people.report.who") : undefined
        }
        className={state === "failed" ? "text-critical" : "text-ink-muted"}
      >
        {t(`projects.people.report.${state}`)}
      </span>
      {state === "ready" && single && (
        <Link
          to="/p/$code/$section"
          params={{ code: single.code, section: "overview" }}
          title={t("projects.people.report.openTitle", { code: single.code })}
          className={ghostButton}
        >
          {t("projects.people.report.open")}
        </Link>
      )}
      {state === "ready" && stale.length > 0 && (
        <>
          <span aria-hidden="true" className="text-ink-faint">
            ·
          </span>
          <span data-report-stale className="text-warning">
            {t("projects.people.report.stale", { count: newCommits })}
          </span>
          {reports.canGenerate && (
            <button type="button" className={ghostButton} onClick={() => reports.generate(stale)}>
              {t("projects.people.report.regenerate")}
            </button>
          )}
        </>
      )}
      {reports.canGenerate && (state === "missing" || state === "failed") && (
        <button type="button" className={ghostButton} onClick={() => reports.generate(todo)}>
          {t(
            state === "failed" ? "projects.people.report.retry" : "projects.people.report.generate",
          )}
        </button>
      )}
    </span>
  );
}

/** Le sei categorie di una persona aperta, in ordine fisso; le vuote non compaiono. */
function PersonDetail({
  activity,
  reports,
  projects,
}: {
  activity: PersonDayActivity;
  reports: Reports;
  projects: Map<string, Project>;
}) {
  const { t, i18n } = useTranslation();
  const openTask = useOpenTask();
  const navigate = useNavigate();
  const tasks = useTasks().data;
  const deptOf = (taskId: string) => tasks?.find((x) => x.id === taskId)?.departmentId ?? null;
  const code = (projectId: string) => projects.get(projectId)?.code ?? "";
  const time = (at: string) => timeText(at, i18n.language);
  const byTime = <T extends { at: string }>(xs: T[]) =>
    [...xs].sort((a, b) => a.at.localeCompare(b.at));

  const moveText = (m: PersonDayActivity["tasksMoved"][number]) => {
    const field = t(`taskDetail.activity.fields.${m.field}`, { defaultValue: m.field });
    const name = field.charAt(0).toUpperCase() + field.slice(1);
    if (m.from && m.to)
      return m.field === "status" ? `${m.from} → ${m.to}` : `${name}: ${m.from} → ${m.to}`;
    if (m.to) return t("projects.people.moveSet", { field: name, value: m.to });
    return t("projects.people.moveCleared", { field: name });
  };

  const sections: { kind: Category; rows: ReactNode[] }[] = [
    {
      kind: "closed",
      rows: byTime(activity.tasksClosed).map((x) => (
        <EntryRow
          key={`c-${x.taskId}`}
          departmentId={deptOf(x.taskId)}
          code={x.code}
          title={x.title}
          projectCode={code(x.projectId)}
          time={time(x.at)}
          onOpen={() => openTask(x.code)}
        />
      )),
    },
    {
      kind: "moved",
      rows: byTime(activity.tasksMoved).map((x, i) => (
        <EntryRow
          key={`m-${x.taskId}-${i}`}
          departmentId={deptOf(x.taskId)}
          code={x.code}
          title={x.title}
          detail={moveText(x)}
          projectCode={code(x.projectId)}
          time={time(x.at)}
          onOpen={() => openTask(x.code)}
        />
      )),
    },
    {
      kind: "comments",
      rows: byTime(activity.comments).map((x) => (
        <EntryRow
          key={`k-${x.id}`}
          departmentId={deptOf(x.taskId)}
          code={x.code}
          title={x.body}
          muted
          projectCode={code(x.projectId)}
          time={time(x.at)}
          onOpen={() => openTask(x.code)}
        />
      )),
    },
    {
      kind: "decisions",
      rows: byTime(activity.decisions).map((x) => {
        const taskCode = x.taskId ? tasks?.find((tk) => tk.id === x.taskId)?.code : undefined;
        return (
          <EntryRow
            key={`d-${x.id}`}
            code={taskCode}
            title={x.title}
            detail={x.source === "answer" ? t("projects.people.answered") : undefined}
            projectCode={code(x.projectId)}
            time={time(x.at)}
            onOpen={taskCode ? () => openTask(taskCode) : undefined}
          />
        );
      }),
    },
    {
      kind: "requests",
      rows: byTime(activity.requestsCreated).map((x) => (
        <EntryRow
          key={`r-${x.requestId}`}
          code={x.code}
          title={x.title}
          projectCode={code(x.projectId)}
          time={time(x.at)}
          onOpen={() =>
            void navigate({
              to: "/p/$code/$section",
              params: { code: code(x.projectId), section: "requests" },
              search: { request: x.requestId },
            } as never)
          }
        />
      )),
    },
  ];

  return (
    <div className="pb-3 pl-[3.25rem]" data-person-detail>
      {sections
        .filter((s) => s.rows.length > 0)
        .map((s) => (
          <CategoryBlock key={s.kind} kind={s.kind}>
            {s.rows}
          </CategoryBlock>
        ))}
      {activity.commits.length > 0 && (
        <CategoryBlock kind="commits">
          <CommitGroups commits={activity.commits} reports={reports} projects={projects} />
        </CategoryBlock>
      )}
    </div>
  );
}

/** Una categoria: l'etichetta di gruppo a sinistra della prima riga, le voci a destra. */
function CategoryBlock({ kind, children }: { kind: Category; children: ReactNode }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      data-person-category={kind}
      className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-2 border-t border-rule first:border-t-0 @max-[620px]:grid-cols-1"
    >
      <h3 id={id} className="heading-group pt-3 @max-[620px]:pt-2.5 @max-[620px]:pb-0.5">
        {t(`projects.people.kinds.${kind}`)}
      </h3>
      <ul className="min-w-0">{children}</ul>
    </section>
  );
}

/**
 * Una voce del catalogo: listello del reparto della task · codice · titolo ·
 * dettaglio (es. «To do → In progress») · progetto · ora. Tutta la riga apre
 * l'oggetto quando si apre.
 */
function EntryRow({
  departmentId,
  code,
  title,
  detail,
  muted = false,
  projectCode,
  time,
  onOpen,
}: {
  departmentId?: string | null;
  code?: string;
  title: string;
  detail?: string;
  muted?: boolean;
  projectCode: string;
  time: string;
  onOpen?: () => void;
}) {
  const deptLabel = useDeptLabel(departmentId);
  const body = (
    <>
      {code && (
        <span className="num w-16 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
          {code}
        </span>
      )}
      <span className={`min-w-0 truncate ${muted ? "text-ink-muted" : "text-ink"}`}>{title}</span>
      {detail && <span className="min-w-0 shrink-[2] truncate text-ink-muted">{detail}</span>}
    </>
  );
  return (
    <li
      title={[title, projectCode, deptLabel].filter(Boolean).join(" · ")}
      className="relative flex h-9 items-center gap-3 pr-3 pl-3 text-sm transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 has-[button:focus-visible]:outline-2 has-[button:focus-visible]:-outline-offset-2 has-[button:focus-visible]:outline-focus"
    >
      {departmentId !== undefined && <DeptStrip departmentId={departmentId} />}
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-baseline gap-3 text-left outline-none after:absolute after:inset-0"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-baseline gap-3">{body}</span>
      )}
      <span className="num w-10 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted @max-[760px]:hidden">
        {projectCode}
      </span>
      <span className="num w-16 shrink-0 text-right whitespace-nowrap text-xs text-ink-muted">{time}</span>
    </li>
  );
}

/**
 * I commit di una persona per repository: l'intestazione dice repository,
 * numero e stato del report del progetto; ogni commit ha sha (7 cifre,
 * tabellari), messaggio originale in inchiostro e sotto la descrizione
 * generata con l'etichetta «Generated text».
 */
function CommitGroups({
  commits,
  reports,
  projects,
}: {
  commits: CommitOfDay[];
  reports: Reports;
  projects: Map<string, Project>;
}) {
  const { i18n } = useTranslation();
  const byRepo = new Map<string, CommitOfDay[]>();
  for (const c of [...commits].sort((a, b) => a.at.localeCompare(b.at))) {
    byRepo.set(c.repo, [...(byRepo.get(c.repo) ?? []), c]);
  }
  return (
    <>
      {[...byRepo].map(([repo, list]) => (
        <li key={repo} data-commit-repo={repo} className="not-first:border-t not-first:border-rule">
          <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 py-1 pr-3 pl-3 text-sm">
            <span className="font-medium text-ink">
              {repo} <span className="num text-ink-faint">· {list.length}</span>
            </span>
            <span className="ml-auto">
              <ReportCell projectIds={[list[0]!.projectId]} reports={reports} projects={projects} />
            </span>
          </div>
          <ul>
            {list.map((c) => (
              <li
                key={c.sha}
                data-commit={c.sha.slice(0, 7)}
                title={c.sha}
                className="grid grid-cols-[4.5rem_minmax(0,1fr)_4rem] gap-x-3 py-1.5 pr-3 pl-3 text-sm"
              >
                <span className="num pt-px text-xs font-semibold tracking-[0.02em] text-ink-muted">
                  {c.sha.slice(0, 7)}
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{c.message}</span>
                  <span className="flex min-w-0 items-start gap-2">
                    <GeneratedTag />
                    <span className="max-w-[72ch] min-w-0 pt-px text-ink-muted">{c.aiSummary}</span>
                  </span>
                </span>
                <span className="num pt-px text-right whitespace-nowrap text-xs text-ink-muted">
                  {timeText(c.at, i18n.language)}
                </span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </>
  );
}

/**
 * In coda, gli autori git non collegati a nessuno: nome dell'autore, numero
 * di commit, «Link a person» (con `users.manage`, come sul web) che apre il
 * menu delle persone; collegato, i commit passano sotto la persona.
 */
function UnlinkedGroup({
  rows,
  people,
  open,
  onToggle,
  reports,
  projects,
  expandAll,
}: {
  rows: PersonDayActivity[];
  people: Person[];
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  reports: Reports;
  projects: Map<string, Project>;
  expandAll: ReactNode;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const toast = useToast();
  const link = useLinkCommitAuthor();
  const canLink = can(viewer, "users.manage");
  const candidates = people.filter((p) => !p.isClaude);
  const title = t("projects.people.unlinked");
  return (
    <section aria-labelledby="people-unlinked" data-people-unlinked className="pt-2">
      <h2 id="people-unlinked" className="flex h-11 items-end gap-2 pr-1 pb-2 pl-4">
        <span className="heading-group">{title}</span>
        <span className="num text-xs text-ink-faint">{rows.length}</span>
        {expandAll}
      </h2>
      <ul aria-label={`${title} ${rows.length}`} className="border-t border-rule">
        {rows.map((p) => {
          const key = keyOf(p);
          const isOpen = open.has(key);
          return (
            <li key={key} data-unlinked-author={p.name} className="@container border-b border-rule">
              <div className="relative flex min-h-11 items-center gap-3 pr-3 pl-2 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 has-[[data-person-toggle]:focus-visible]:outline-2 has-[[data-person-toggle]:focus-visible]:-outline-offset-2 has-[[data-person-toggle]:focus-visible]:outline-focus">
                <button
                  type="button"
                  data-person-toggle
                  aria-expanded={isOpen}
                  onClick={() => onToggle(key)}
                  title={t("projects.people.unlinkedHint")}
                  className="grid min-w-0 flex-1 grid-cols-[16px_22px_minmax(0,11rem)_minmax(0,1fr)] items-center gap-x-2.5 py-1.5 text-left outline-none after:absolute after:inset-0 @max-[620px]:grid-cols-[16px_22px_minmax(0,1fr)]"
                >
                  <Disclosure open={isOpen} />
                  <Avatar person={null} />
                  <span className="min-w-0 truncate text-md font-medium text-ink">“{p.name}”</span>
                  <span className="num min-w-0 truncate text-sm text-ink-muted @max-[620px]:col-start-3">
                    {t("projects.people.unlinkedCommits", { count: p.commits.length })}
                  </span>
                </button>
                {canLink && (
                  <span className="relative shrink-0">
                    <MenuButton
                      menuLabel={t("projects.people.linkTo", { name: p.name })}
                      className={ghostButton}
                      align="right"
                      label={
                        <>
                          {t("projects.people.link")}
                          <Chevron />
                        </>
                      }
                    >
                      {(close) => (
                        <MenuGroup label={t("projects.people.linkTo", { name: p.name })}>
                          <div className="flex max-h-72 flex-col overflow-auto">
                            {candidates.map((person) => (
                              <button
                                key={person.id}
                                type="button"
                                role="menuitem"
                                tabIndex={-1}
                                className={itemClass}
                                onClick={() => {
                                  close();
                                  link.mutate(
                                    { authorName: p.name, personId: person.id },
                                    {
                                      onSuccess: () =>
                                        toast.show(
                                          t("projects.people.linked", {
                                            name: p.name,
                                            person: person.name,
                                          }),
                                        ),
                                      onError: () =>
                                        toast.error(
                                          t("projects.people.linkFailed", { name: p.name }),
                                        ),
                                    },
                                  );
                                }}
                              >
                                <Avatar person={person} />
                                <span className="min-w-0 truncate">{person.name}</span>
                              </button>
                            ))}
                          </div>
                        </MenuGroup>
                      )}
                    </MenuButton>
                  </span>
                )}
              </div>
              {isOpen && (
                <div className="pb-3 pl-[3.25rem]">
                  <CategoryBlock kind="commits">
                    <CommitGroups commits={p.commits} reports={reports} projects={projects} />
                  </CategoryBlock>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * «By person» senza il permesso (un link diretto): lo dice, e porta alla
 * vista per progetto.
 */
export function PeopleActivityForbidden({ onByProject }: { onByProject: () => void }) {
  const { t } = useTranslation();
  return (
    <PageEmpty
      title={t("projects.people.states.forbiddenTitle")}
      body={t("projects.people.states.forbiddenBody")}
      action={
        <button type="button" className={secondaryButton} onClick={onByProject}>
          {t("projects.people.states.byProject")}
        </button>
      }
    />
  );
}
