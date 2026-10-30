import { useTranslation } from "react-i18next";
import { usePeople, useProjects, useProjectStatuses, useUpdateTask } from "../../data/queries";
import type { Milestone, Person, ProjectStatus, Task, TaskPatch, TaskSize } from "../../data/types";
import { addWeeks, currentWeek, weekLabel } from "../../domain/weeks";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { Avatar, PersonChip, personName } from "../../tasks-ui/PersonChip";
import { FamilySign, StatusLabel } from "../../tasks-ui/StatusLabel";
import { useToast } from "../../tasks-ui/Toast";
import { Chevron, MenuButton } from "./controls";

// Le scelte di un campo di task, come voci di menu: le usano il menu in riga
// dell'elenco e la barra delle azioni in blocco.

const SIZES: TaskSize[] = ["XS", "S", "M", "L", "XL"];

/** Le settimane che si possono scegliere: da due prima di questa a otto dopo. */
export function weekChoices(): string[] {
  return Array.from({ length: 11 }, (_, i) => addWeeks(currentWeek(), i - 2));
}

/** «W43» da «2026-W43». */
export function shortWeek(week: string): string {
  return week.slice(week.indexOf("-") + 1);
}

/**
 * Gli assegnatari possibili di un progetto: i membri (Claude compreso), per
 * nome. Una persona disattivata non c'è (il campo lo calcola il livello dati).
 */
export function useProjectMembers(projectId: string | undefined): Person[] | undefined {
  const projects = useProjects().data;
  const people = usePeople().data;
  if (!projectId || !projects || !people) return undefined;
  const members = projects.find((p) => p.id === projectId)?.memberIds ?? [];
  return people
    .filter((p) => members.includes(p.id) && !p.deactivated)
    .sort((a, b) => Number(a.isClaude) - Number(b.isClaude) || a.name.localeCompare(b.name));
}

export function StatusOptions({
  statuses,
  current,
  onPick,
}: {
  statuses: ProjectStatus[];
  current?: string;
  onPick: (statusId: string) => void;
}) {
  return (
    <>
      {statuses.map((s) => (
        <RadioItem key={s.id} checked={s.id === current} onSelect={() => onPick(s.id)}>
          <FamilySign family={s.family} />
          <span className="min-w-0 truncate" title={s.name}>
            {s.name}
          </span>
        </RadioItem>
      ))}
    </>
  );
}

export function AssigneeOptions({
  people,
  current,
  onPick,
}: {
  people: Person[];
  current?: string | null;
  onPick: (personId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <RadioItem checked={current === null} onSelect={() => onPick(null)}>
        <Avatar person={null} />
        <span className="text-ink-muted">{t("taskUi.unassigned")}</span>
      </RadioItem>
      {people.map((p) => (
        <RadioItem key={p.id} checked={p.id === current} onSelect={() => onPick(p.id)}>
          <Avatar person={p} />
          <span className="min-w-0 truncate">{p.name}</span>
        </RadioItem>
      ))}
    </>
  );
}

export function WeekOptions({
  current,
  onPick,
}: {
  current?: string | null;
  onPick: (week: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const now = currentWeek();
  return (
    <>
      <RadioItem checked={current === null} onSelect={() => onPick(null)}>
        <span className="text-ink-muted">{t("tasks.bulk.noWeek")}</span>
      </RadioItem>
      {weekChoices().map((w) => (
        <RadioItem key={w} checked={w === current} onSelect={() => onPick(w)}>
          <span className="num w-9 shrink-0 font-semibold">{shortWeek(w)}</span>
          <span className="num text-ink-muted">
            {w === now ? t("tasks.bulk.thisWeek", { week: weekLabel(w, i18n.language) }) : weekLabel(w, i18n.language)}
          </span>
        </RadioItem>
      ))}
    </>
  );
}

export function MilestoneOptions({
  milestones,
  current,
  onPick,
}: {
  milestones: Milestone[];
  current?: string | null;
  onPick: (milestoneId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <RadioItem checked={current === null} onSelect={() => onPick(null)}>
        <span className="text-ink-muted">{t("tasks.groups.noMilestone")}</span>
      </RadioItem>
      {milestones
        .filter((m) => !m.closed)
        .map((m) => (
          <RadioItem key={m.id} checked={m.id === current} onSelect={() => onPick(m.id)}>
            <span className="min-w-0 truncate" title={m.name}>
              {m.name}
            </span>
          </RadioItem>
        ))}
    </>
  );
}

export function SizeOptions({
  current,
  onPick,
}: {
  current?: TaskSize | null;
  onPick: (size: TaskSize | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <RadioItem checked={current === null} onSelect={() => onPick(null)}>
        <span className="text-ink-muted">{t("taskUi.size.none")}</span>
      </RadioItem>
      {SIZES.map((s) => (
        <RadioItem key={s} checked={s === current} onSelect={() => onPick(s)}>
          <span className="num font-semibold">{s}</span>
        </RadioItem>
      ))}
    </>
  );
}

// --- modifica in riga -----------------------------------------------------------

const cellButton =
  "group/cell -mx-1.5 flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-expanded:bg-ink/8";

/** Cambia un campo di una task subito; se non riesce, torna com'era e lo dice. */
export function useInlineUpdate() {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateTask();
  return (task: Task, patch: TaskPatch) =>
    update.mutate(
      { id: task.id, patch },
      { onError: () => toast.error(t("tasks.list.changeFailed", { code: task.code })) },
    );
}

/** Lo stato di una task nell'elenco, modificabile: il segno, il nome e il menu degli stati. */
export function InlineStatus({ task }: { task: Task }) {
  const { t } = useTranslation();
  const statuses = useProjectStatuses(task.projectId).data;
  const status = statuses?.find((s) => s.id === task.statusId);
  const change = useInlineUpdate();
  if (!statuses || !status) return null;
  return (
    <MenuButton
      menuLabel={t("tasks.list.statusMenu", { code: task.code })}
      ariaLabel={t("tasks.list.changeStatus", { code: task.code, name: status.name })}
      className={cellButton}
      label={
        <>
          <StatusLabel status={status} nameClassName="@max-[560px]:sr-only" />
          <span className="opacity-0 group-hover/cell:opacity-100 group-aria-expanded/cell:opacity-100 @max-[560px]:hidden">
            <Chevron />
          </span>
        </>
      }
    >
      {(close) => (
        <MenuGroup>
          <StatusOptions
            statuses={statuses}
            current={task.statusId}
            onPick={(statusId) => {
              close();
              if (statusId !== task.statusId) change(task, { statusId });
            }}
          />
        </MenuGroup>
      )}
    </MenuButton>
  );
}

/** L'assegnatario di una task nell'elenco, modificabile: fra i membri del progetto. */
export function InlineAssignee({ task }: { task: Task }) {
  const { t } = useTranslation();
  const members = useProjectMembers(task.projectId);
  const people = usePeople().data;
  const change = useInlineUpdate();
  if (!members) return <PersonChip personId={task.assigneeId} />;
  const assignee = people?.find((p) => p.id === task.assigneeId);
  const name = assignee ? personName(t, assignee) : t("taskUi.unassigned");
  return (
    <MenuButton
      menuLabel={t("tasks.list.assigneeMenu", { code: task.code })}
      ariaLabel={t("tasks.list.changeAssignee", { code: task.code, name })}
      wrapperClassName="flex w-full min-w-0"
      className={`${cellButton} w-[calc(100%+12px)] max-w-none`}
      label={<PersonChip personId={task.assigneeId} nameClassName="@max-[760px]:sr-only" />}
    >
      {(close) => (
        <MenuGroup>
          <AssigneeOptions
            people={members}
            current={task.assigneeId}
            onPick={(assigneeId) => {
              close();
              if (assigneeId !== task.assigneeId) change(task, { assigneeId });
            }}
          />
        </MenuGroup>
      )}
    </MenuButton>
  );
}
