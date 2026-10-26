import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { now } from "../../data/dates";
import {
  useAutomationRuns,
  useAutomations,
  useMyAutomationRuns,
  useProjects,
} from "../../data/queries";
import type { AutomationRunRow } from "../../data/types";
import { rowKeys } from "../home/blocks/BlockSection";
import { PageEmpty, PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { quietButton } from "../tasks/controls";
import { FilterChip } from "./AutomationList";
import { isFinished, nowPhrase, shortDate, type Names } from "./format";
import { RunStatusWord, codeClass, useAttention, useNames } from "./shared";

// Le esecuzioni: la riga (44 px — codice, titolo, stato, frase di adesso,
// data d'inizio) e la vista `#/automations?view=runs` (shape §6). Le righe
// sono link all'esecuzione; J/K le scorrono.

/** Prima quelle che aspettano me, poi le fallite, poi le altre dalla più recente. */
export function orderRuns(runs: AutomationRunRow[], waitingMe: ReadonlySet<string>) {
  const rank = (r: AutomationRunRow) => (waitingMe.has(r.id) ? 0 : r.status === "failed" ? 1 : 2);
  return [...runs].sort(
    (a, b) => rank(a) - rank(b) || b.startedAt.localeCompare(a.startedAt) || b.n - a.n,
  );
}

export function RunRow({
  run,
  names,
  mine,
  currentVersion,
}: {
  run: AutomationRunRow;
  names: Names;
  mine: boolean;
  /** La versione corrente dell'automazione: se l'esecuzione gira con un'altra, «v2». */
  currentVersion?: number;
}) {
  const { t, i18n } = useTranslation();
  const phrase = nowPhrase(run, names, t, now());
  const started = shortDate(run.startedAt, i18n.language);
  const statusFull = t(`automations.runStatus.full.${run.status}`);
  const otherVersion = currentVersion !== undefined && run.version !== currentVersion;
  return (
    <li className="border-b border-rule">
      <Link
        to="/automations/$code/runs/$n"
        params={{ code: run.automationCode, n: String(run.n) }}
        data-run-row={run.code}
        aria-label={t("automations.runRow.label", {
          code: run.code,
          title: run.title,
          status: statusFull,
          phrase,
          date: started,
        })}
        className="group grid min-h-11 grid-cols-[96px_minmax(0,1.2fr)_minmax(108px,auto)_minmax(0,1.5fr)_56px] items-center gap-3 rounded-md px-3 py-1.5 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:bg-ink/6 max-[1100px]:grid-cols-[96px_minmax(0,1fr)_minmax(96px,auto)_56px]"
      >
        <span className={`${codeClass} truncate`}>{run.code}</span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-md text-ink">{run.title}</span>
          {otherVersion && (
            <span className="num shrink-0 text-xs text-ink-muted">
              {t("automations.version.short", { n: run.version })}
            </span>
          )}
        </span>
        <RunStatusWord status={run.status} mine={mine} short />
        <span className="truncate text-sm text-ink-muted max-[1100px]:hidden">{phrase}</span>
        <span className="num text-right text-xs text-ink-faint">{started}</span>
      </Link>
    </li>
  );
}

/** Un elenco di righe d'esecuzione, J/K fra le righe. */
export function RunRows({
  runs,
  label,
  currentVersion,
}: {
  runs: AutomationRunRow[];
  label: string;
  currentVersion?: number;
}) {
  const names = useNames();
  const attention = useAttention();
  return (
    <ul aria-label={label} onKeyDown={rowKeys("[data-run-row]")} className="flex flex-col">
      {runs.map((r) => (
        <RunRow
          key={r.id}
          run={r}
          names={names}
          mine={attention.waitingMe.has(r.id)}
          currentVersion={currentVersion}
        />
      ))}
    </ul>
  );
}

type RunsSearch = {
  project?: string;
  automation?: string;
  status?: string;
  mine?: string;
};

/** Il filtro di stato della vista esecuzioni. */
function matchesStatus(r: AutomationRunRow, status: string | undefined): boolean {
  switch (status) {
    case undefined:
      return !isFinished(r.status);
    case "waiting":
      return r.status.startsWith("waiting_");
    case "finished":
      return true;
    default:
      return r.status === status;
  }
}

/** `#/automations?view=runs`: le esecuzioni di tutte le automazioni che vedo. */
export function RunsView({ search }: { search: RunsSearch }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const runs = useAutomationRuns();
  const automations = useAutomations().data ?? [];
  const projects = useProjects().data ?? [];
  const attention = useAttention();
  const project = projects.find((p) => p.code === search.project);
  // `mine=1`: le esecuzioni che mi riguardano, le stesse del blocco Home «Automations» [A 25].
  const mine = new Set((useMyAutomationRuns().data ?? []).map((r) => r.id));
  const automation = automations.find((a) => a.code === search.automation);
  const set = (patch: Partial<RunsSearch>) =>
    void navigate({
      to: "/automations",
      search: (prev: Record<string, unknown>) => ({ ...prev, view: "runs", ...patch }),
    } as never);
  const filtered = orderRuns(
    (runs.data ?? [])
      .filter(
        (r) =>
          !search.project ||
          (project && (r.projectIds.includes(project.id) || r.automationProjectId === project.id)),
      )
      .filter((r) => !search.automation || r.automationCode === search.automation)
      .filter((r) => !search.mine || mine.has(r.id))
      // Le mie comprendono le fallite: senza un filtro di stato si vedono tutte.
      .filter((r) => (search.mine && !search.status) || matchesStatus(r, search.status)),
    attention.waitingMe,
  );
  const filtering = !!(search.project || search.automation || search.status || search.mine);
  const statuses = ["running", "waiting", "suspended", "failed", "finished"] as const;
  const projectsWithRuns = projects.filter((p) =>
    (runs.data ?? []).some((r) => r.projectIds.includes(p.id) || r.automationProjectId === p.id),
  );

  return (
    <>
      <div
        role="toolbar"
        aria-label={t("automations.filters.label")}
        className="flex flex-wrap items-center gap-2 pr-8 pb-3"
      >
        <FilterChip
          label={t("automations.filters.project")}
          value={project ? project.code : undefined}
          options={projectsWithRuns.map((p) => ({ value: p.code, label: `${p.code} · ${p.name}` }))}
          onChange={(v) => set({ project: v })}
        />
        <FilterChip
          label={t("automations.filters.automation")}
          value={automation?.code}
          options={automations.map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` }))}
          onChange={(v) => set({ automation: v })}
        />
        <FilterChip
          label={t("automations.filters.status")}
          value={search.status ? t(`automations.runFilter.${search.status}`) : undefined}
          options={statuses.map((s) => ({ value: s, label: t(`automations.runFilter.${s}`) }))}
          onChange={(v) => set({ status: v })}
        />
        {filtering && (
          <button
            type="button"
            className={quietButton}
            onClick={() =>
              set({ project: undefined, automation: undefined, status: undefined, mine: undefined })
            }
          >
            {t("automations.filters.clear")}
          </button>
        )}
      </div>
      {runs.isError ? (
        <PageError message={t("automations.errors.loadRuns")} onRetry={() => void runs.refetch()} />
      ) : runs.data === undefined ? (
        <PageSkeleton rows={6} />
      ) : filtered.length === 0 ? (
        <PageEmpty
          title={filtering ? t("automations.empty.runsFiltered") : t("automations.empty.runs")}
          action={
            filtering ? (
              <button
                type="button"
                className={quietButton}
                onClick={() =>
                  set({
                    project: undefined,
                    automation: undefined,
                    status: undefined,
                    mine: undefined,
                  })
                }
              >
                {t("automations.filters.clear")}
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="pr-8">
          <div className="border-t border-rule">
            <RunRows runs={filtered} label={t("automations.runs.title")} />
          </div>
        </div>
      )}
    </>
  );
}
