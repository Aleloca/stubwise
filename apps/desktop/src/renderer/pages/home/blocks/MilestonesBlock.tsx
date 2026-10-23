import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../../data/dates";
import { useMilestones, useProjects, useSessionPersonId, useTasks } from "../../../data/queries";
import type { FilterCriteria, Milestone, Project } from "../../../data/types";
import { DueDate } from "../../../tasks-ui/TaskRow";
import { BlockSection, Capped, queryState } from "./BlockSection";

const CLOSED: FilterCriteria = { families: ["closed"] };
const HORIZON_DAYS = 28;

const plusDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * «Upcoming milestones»: i traguardi aperti dei miei progetti con scadenza
 * nelle prossime 4 settimane, dal più vicino, con l'avanzamento detto a
 * parole («3 of 8 closed») e mostrato da una linea d'inchiostro. Il nome
 * apre le task del progetto.
 */
export function MilestonesBlock() {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const milestones = useMilestones();
  const projects = useProjects();
  const tasks = useTasks();
  const closed = useTasks(CLOSED);
  const horizon = plusDays(TODAY, HORIZON_DAYS);
  const mine = new Map(
    (projects.data ?? []).filter((p) => p.memberIds.includes(me)).map((p) => [p.id, p]),
  );
  const closedIds = new Set((closed.data ?? []).map((x) => x.id));
  const list = (milestones.data ?? [])
    .filter(
      (m) =>
        !m.closed &&
        m.dueDate &&
        m.dueDate >= TODAY &&
        m.dueDate <= horizon &&
        mine.has(m.projectId),
    )
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || a.name.localeCompare(b.name));
  const progress = (m: Milestone) => {
    const of = (tasks.data ?? []).filter((x) => x.milestoneId === m.id);
    return { total: of.length, closed: of.filter((x) => closedIds.has(x.id)).length };
  };
  const state = queryState([milestones, projects, tasks, closed], {
    when: list.length === 0,
    text: t("home.milestones.empty"),
  });
  return (
    <BlockSection title={t("home.blocks.upcomingMilestones")} count={list.length} state={state}>
      <Capped
        items={list}
        render={(m) => (
          <MilestoneRow
            key={m.id}
            milestone={m}
            project={mine.get(m.projectId)!}
            {...progress(m)}
          />
        )}
      />
    </BlockSection>
  );
}

function MilestoneRow({
  milestone,
  project,
  total,
  closed,
}: {
  milestone: Milestone;
  project: Project;
  total: number;
  closed: number;
}) {
  const { t } = useTranslation();
  const share = total > 0 ? closed / total : 0;
  return (
    <li className="relative grid h-11 grid-cols-[minmax(0,1fr)_minmax(96px,160px)_64px] items-center gap-4 border-b border-rule pr-3 pl-4 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4">
      <span className="flex min-w-0 items-baseline gap-3">
        <span className="num w-16 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink-muted">
          {project.code}
        </span>
        <Link
          to="/p/$code/$section"
          params={{ code: project.code, section: "tasks" }}
          title={`${milestone.name} · ${project.name}`}
          className="min-w-0 truncate text-md text-ink outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
        >
          {milestone.name}
        </Link>
        <span className="min-w-0 shrink-[2] truncate text-sm text-ink-muted">{project.name}</span>
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="num truncate text-xs text-ink-muted">
          {total > 0
            ? t("home.milestones.progress", { closed, total })
            : t("home.milestones.noTasks")}
        </span>
        <span aria-hidden="true" className="h-[3px] w-full rounded-[1px] bg-ink/10">
          <span
            className="block h-full rounded-[1px] bg-ink"
            style={{ width: `${share * 100}%` }}
          />
        </span>
      </span>
      <DueDate date={milestone.dueDate} overdue={false} />
    </li>
  );
}
