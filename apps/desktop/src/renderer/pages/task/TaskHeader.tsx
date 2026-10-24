import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../data/dates";
import {
  useDepartments,
  useMilestones,
  useProjects,
  useProjectStatuses,
} from "../../data/queries";
import type { Task } from "../../data/types";
import { useViewer } from "../../data/viewer";
import { weekLabel } from "../../domain/weeks";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { PersonChip } from "../../tasks-ui/PersonChip";
import { PRIORITIES, PriorityValue, TASK_TYPES } from "../../tasks-ui/PriorityMark";
import { SourceMark } from "../../tasks-ui/SourceMark";
import { StatusLabel } from "../../tasks-ui/StatusLabel";
import { DueDate, formatDue } from "../../tasks-ui/TaskRow";
import { useToast } from "../../tasks-ui/Toast";
import { Chevron, MenuButton } from "../tasks/controls";
import {
  AssigneeOptions,
  MilestoneOptions,
  SizeOptions,
  StatusOptions,
  WeekOptions,
  shortWeek,
  useInlineUpdate,
  useProjectMembers,
} from "../tasks/pickers";
import { CloseIcon, PlusIcon, ghostButton } from "./parts";
import { TaskMoreMenu } from "./TaskMoreMenu";

/** Il bottone-valore di un campo modificabile: il valore com'è, tinta e freccia al passaggio. */
export const fieldButton =
  "group/field -mx-1.5 flex h-8 max-w-[calc(100%+12px)] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-expanded:bg-ink/8";

export const hoverChevron = (
  <span className="opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/field:opacity-100 group-aria-expanded/field:opacity-100">
    <Chevron />
  </span>
);

/** Una riga di campo: nome a sinistra (colonna fissa), valore a destra. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="flex h-8 items-center text-sm text-ink-muted">{label}</dt>
      <dd className="flex min-h-8 min-w-0 items-center">{children}</dd>
    </div>
  );
}

/** Il valore di sola lettura: stessa riga, nessun menu. */
function Static({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink">{children}</span>;
}

const muted = (text: string) => <span className="truncate text-ink-faint">{text}</span>;

/**
 * Un campo che si cambia da un menu: senza `tickets.edit` è il solo valore.
 * `value` è ciò che si vede; `name` il valore detto a parole, per il nome
 * accessibile («Status: In review. Change»).
 */
function MenuField({
  label,
  name,
  value,
  canEdit,
  menuLabel,
  children,
}: {
  label: string;
  name: string;
  value: ReactNode;
  canEdit: boolean;
  menuLabel: string;
  children: (close: () => void) => ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Field label={label}>
      {canEdit ? (
        <MenuButton
          menuLabel={menuLabel}
          ariaLabel={t("taskDetail.fields.change", { field: label, value: name })}
          wrapperClassName="flex min-w-0 max-w-full"
          className={fieldButton}
          label={
            <>
              {value}
              {hoverChevron}
            </>
          }
        >
          {children}
        </MenuButton>
      ) : (
        <Static>{value}</Static>
      )}
    </Field>
  );
}

/** Il titolo: si legge come titolo, con `tickets.edit` un clic lo rende un campo. */
function TitleEditor({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const { t } = useTranslation();
  const change = useInlineUpdate();
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    const next = draft?.trim();
    setDraft(null);
    if (next && next !== task.title) change(task, { title: next });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      // Esc annulla la modifica, non chiude il pannello.
      e.preventDefault();
      setDraft(null);
    }
  };
  if (draft !== null) {
    return (
      <textarea
        autoFocus
        aria-label={t("taskDetail.title")}
        value={draft}
        rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={onKeyDown}
        className="-mx-1.5 w-[calc(100%+12px)] resize-none rounded-md border border-rule-strong bg-transparent px-1.5 py-0.5 text-xl font-semibold text-ink [field-sizing:content]"
      />
    );
  }
  const heading = (
    <h2 className="text-xl font-semibold text-balance text-ink [overflow-wrap:anywhere]">
      {task.title}
    </h2>
  );
  if (!canEdit) return heading;
  return (
    <div className="group/title relative -mx-1.5 rounded-md px-1.5 py-0.5 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6">
      {heading}
      <button
        type="button"
        aria-label={t("taskDetail.editTitle")}
        title={t("taskDetail.editTitle")}
        onClick={() => setDraft(task.title)}
        className="absolute inset-0 cursor-text rounded-md"
      />
    </div>
  );
}

/** Le etichette: gettoni con «×», e un campo per aggiungerne una. */
function LabelsField({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const { t } = useTranslation();
  const change = useInlineUpdate();
  const [adding, setAdding] = useState<string | null>(null);
  const add = () => {
    const label = adding?.trim();
    setAdding(null);
    if (label && !task.labels.includes(label)) change(task, { labels: [...task.labels, label] });
  };
  return (
    <Field label={t("taskDetail.fields.labels")}>
      <span className="flex min-w-0 flex-wrap items-center gap-1 py-1">
        {task.labels.length === 0 && !canEdit && muted(t("taskDetail.fields.noLabels"))}
        {task.labels.map((label) => (
          <span
            key={label}
            className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-rule-strong pr-1 pl-2 text-xs text-ink"
          >
            <span className="truncate">{label}</span>
            {canEdit && (
              <button
                type="button"
                aria-label={t("taskDetail.fields.removeLabel", { label })}
                title={t("taskDetail.fields.removeLabel", { label })}
                onClick={() => change(task, { labels: task.labels.filter((l) => l !== label) })}
                className="grid size-4 place-items-center rounded-[3px] text-ink-faint hover:bg-ink/10 hover:text-ink"
              >
                <CloseIcon size={10} />
              </button>
            )}
          </span>
        ))}
        {canEdit &&
          (adding === null ? (
            <button type="button" className={`${ghostButton} h-6 px-1.5`} onClick={() => setAdding("")}>
              <PlusIcon />
              {t("taskDetail.fields.addLabel")}
            </button>
          ) : (
            <input
              autoFocus
              aria-label={t("taskDetail.fields.newLabel")}
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onBlur={add}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setAdding(null);
                }
              }}
              className="h-6 w-28 rounded-md border border-rule-strong bg-transparent px-1.5 text-xs text-ink"
            />
          ))}
      </span>
    </Field>
  );
}

/** La scadenza: il calendario del sistema, con il tema dell'app (`color-scheme`). */
function DueField({ task, canEdit }: { task: Task; canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const change = useInlineUpdate();
  const statuses = useProjectStatuses(task.projectId).data;
  const closed = statuses?.find((s) => s.id === task.statusId)?.family === "closed";
  const overdue = !!task.dueDate && task.dueDate < TODAY && !closed;
  const label = t("taskDetail.fields.due");
  if (!canEdit) {
    return (
      <Field label={label}>
        {task.dueDate ? (
          <DueDate date={task.dueDate} overdue={overdue} />
        ) : (
          <Static>{muted(t("taskDetail.fields.noDue"))}</Static>
        )}
      </Field>
    );
  }
  const value = task.dueDate ? formatDue(task.dueDate, i18n.language) : null;
  // Il valore si mostra come nelle righe («Oct 24», nella lingua dell'app);
  // il calendario è quello del sistema, aperto dal bottone.
  const openPicker = () => {
    const el = input.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };
  return (
    <Field label={label}>
      <span className="relative flex min-w-0 items-center gap-0.5">
        <button
          type="button"
          onClick={openPicker}
          aria-label={t("taskDetail.fields.change", {
            field: label,
            value: value ?? t("taskDetail.fields.noDue"),
          })}
          className={`${fieldButton} group/field`}
        >
          {value ? (
            <span
              className={`num flex items-center gap-1.5 ${overdue ? "font-semibold text-critical" : ""}`}
            >
              {value}
              {overdue && <span className="text-xs">· {t("taskDetail.fields.overdue")}</span>}
            </span>
          ) : (
            muted(t("taskDetail.fields.noDue"))
          )}
          {hoverChevron}
        </button>
        {task.dueDate && (
          <button
            type="button"
            aria-label={t("taskDetail.fields.clearDue")}
            title={t("taskDetail.fields.clearDue")}
            onClick={() => change(task, { dueDate: null })}
            className="ml-1.5 grid size-6 place-items-center rounded-md text-ink-faint hover:bg-ink/6 hover:text-ink"
          >
            <CloseIcon size={12} />
          </button>
        )}
        <input
          ref={input}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          value={task.dueDate ?? ""}
          onChange={(e) => change(task, { dueDate: e.target.value || null })}
          className="pointer-events-none absolute bottom-0 left-0 h-0 w-0 opacity-0"
        />
      </span>
    </Field>
  );
}

/**
 * La testata del pannello: barra con codice (si copia), «Follow» e
 * chiusura; il titolo; i campi nell'ordine di riga e carta (stato ·
 * assegnatario · reparto · taglia · scadenza · settimana · traguardo), poi
 * tipo, priorità, etichette. Su Windows la barra riserva i controlli finestra
 * (`page-header`), che coprono l'angolo in alto a destra del pannello.
 */
export function TaskHeader({
  task,
  canEdit,
  onClose,
}: {
  task: Task;
  canEdit: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { viewer } = useViewer();
  const me = viewer.personId;
  const toast = useToast();
  const change = useInlineUpdate();
  const statuses = useProjectStatuses(task.projectId).data;
  const members = useProjectMembers(task.projectId);
  const departments = useDepartments().data;
  const milestones = useMilestones(task.projectId).data;
  const project = useProjects().data?.find((p) => p.id === task.projectId);
  const status = statuses?.find((s) => s.id === task.statusId);
  const department = departments?.find((d) => d.id === task.departmentId);
  const milestone = milestones?.find((m) => m.id === task.milestoneId);
  const assignee = members?.find((p) => p.id === task.assigneeId);
  const following = task.followerIds.includes(me);

  const copyCode = () => {
    void navigator.clipboard?.writeText(task.code).catch(() => {});
    toast.show(t("taskDetail.copied", { code: task.code }));
  };
  const toggleFollow = () =>
    change(task, {
      followerIds: following
        ? task.followerIds.filter((id) => id !== me)
        : [...task.followerIds, me],
    });

  const none = (key: string) => muted(t(key));

  return (
    <header className="flex flex-col">
      <div className="page-header box-content flex h-12 shrink-0 items-center gap-1 pl-4 [--page-header-pr:8px]">
        <button
          type="button"
          onClick={copyCode}
          title={t("taskDetail.copyCode")}
          aria-label={t("taskDetail.copyCodeLabel", { code: task.code })}
          className="num -ml-1.5 inline-flex h-7 shrink-0 items-center rounded-md px-1.5 whitespace-nowrap text-xs font-semibold tracking-[0.02em] text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
        >
          {task.code}
        </button>
        {project && (
          <span className="min-w-0 truncate text-xs text-ink-faint" title={project.name}>
            {project.name}
          </span>
        )}
        <button
          type="button"
          aria-pressed={following}
          onClick={toggleFollow}
          className={`${ghostButton} ml-auto ${following ? "text-ink" : ""}`}
        >
          <EyeIcon filled={following} />
          {following ? t("taskDetail.following") : t("taskDetail.follow")}
        </button>
        <TaskMoreMenu
          task={task}
          project={project}
          status={status}
          department={department}
          milestone={milestone}
        />
        <button
          type="button"
          onClick={onClose}
          aria-label={t("taskDetail.close")}
          title={t("taskDetail.close")}
          className={`${ghostButton} w-8 justify-center px-0`}
        >
          <CloseIcon />
        </button>
      </div>

      <div className="px-4 pt-1 pb-3">
        <TitleEditor task={task} canEdit={canEdit} />
      </div>

      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 px-4 pb-4">
        <MenuField
          label={t("taskDetail.fields.status")}
          name={status?.name ?? ""}
          value={<StatusLabel status={status} />}
          canEdit={canEdit && !!statuses}
          menuLabel={t("tasks.list.statusMenu", { code: task.code })}
        >
          {(close) => (
            <MenuGroup>
              <StatusOptions
                statuses={statuses ?? []}
                current={task.statusId}
                onPick={(statusId) => {
                  close();
                  if (statusId !== task.statusId) change(task, { statusId });
                }}
              />
            </MenuGroup>
          )}
        </MenuField>

        <MenuField
          label={t("taskDetail.fields.assignee")}
          name={assignee?.name ?? t("taskUi.unassigned")}
          value={<PersonChip personId={task.assigneeId} />}
          canEdit={canEdit && !!members}
          menuLabel={t("tasks.list.assigneeMenu", { code: task.code })}
        >
          {(close) => (
            <MenuGroup>
              <AssigneeOptions
                people={members ?? []}
                current={task.assigneeId}
                onPick={(assigneeId) => {
                  close();
                  if (assigneeId !== task.assigneeId) change(task, { assigneeId });
                }}
              />
            </MenuGroup>
          )}
        </MenuField>

        <MenuField
          label={t("taskDetail.fields.department")}
          name={department?.name ?? ""}
          value={
            department && (
              <>
                <span
                  aria-hidden="true"
                  className="h-3 w-[3px] shrink-0 rounded-[1px]"
                  style={{ background: `var(${department.colorToken})` }}
                />
                <span className="truncate">{department.name}</span>
              </>
            )
          }
          canEdit={canEdit && !!departments}
          menuLabel={t("taskDetail.fields.departmentMenu", { code: task.code })}
        >
          {(close) => (
            <MenuGroup>
              {(departments ?? []).map((d) => (
                <RadioItem
                  key={d.id}
                  checked={d.id === task.departmentId}
                  onSelect={() => {
                    close();
                    if (d.id !== task.departmentId) change(task, { departmentId: d.id });
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="h-3 w-[3px] shrink-0 rounded-[1px]"
                    style={{ background: `var(${d.colorToken})` }}
                  />
                  {d.name}
                </RadioItem>
              ))}
            </MenuGroup>
          )}
        </MenuField>

        <MenuField
          label={t("taskDetail.fields.size")}
          name={task.size ?? t("taskUi.size.none")}
          value={
            task.size ? (
              <span className="num font-semibold">{task.size}</span>
            ) : (
              none("taskUi.size.none")
            )
          }
          canEdit={canEdit}
          menuLabel={t("taskDetail.fields.sizeMenu", { code: task.code })}
        >
          {(close) => (
            <MenuGroup>
              <SizeOptions
                current={task.size}
                onPick={(size) => {
                  close();
                  if (size !== task.size) change(task, { size });
                }}
              />
            </MenuGroup>
          )}
        </MenuField>

        <DueField task={task} canEdit={canEdit} />

        <MenuField
          label={t("taskDetail.fields.week")}
          name={task.plannedWeek ? weekLabel(task.plannedWeek, i18n.language) : t("tasks.bulk.noWeek")}
          value={
            task.plannedWeek ? (
              <span className="num flex min-w-0 items-baseline gap-1.5">
                <span className="font-semibold">{shortWeek(task.plannedWeek)}</span>
                <span className="truncate text-ink-muted">
                  {weekLabel(task.plannedWeek, i18n.language)}
                </span>
              </span>
            ) : (
              none("tasks.bulk.noWeek")
            )
          }
          canEdit={canEdit}
          menuLabel={t("taskDetail.fields.weekMenu", { code: task.code })}
        >
          {(close) => (
            <MenuGroup>
              <WeekOptions
                current={task.plannedWeek}
                onPick={(plannedWeek) => {
                  close();
                  if (plannedWeek !== task.plannedWeek) change(task, { plannedWeek });
                }}
              />
            </MenuGroup>
          )}
        </MenuField>

        <MenuField
          label={t("taskDetail.fields.milestone")}
          name={milestone?.name ?? t("tasks.groups.noMilestone")}
          value={
            milestone ? (
              <span className="truncate" title={milestone.name}>
                {milestone.name}
              </span>
            ) : (
              none("tasks.groups.noMilestone")
            )
          }
          canEdit={canEdit && !!milestones}
          menuLabel={t("taskDetail.fields.milestoneMenu", { code: task.code })}
        >
          {(close) => (
            <MenuGroup>
              <MilestoneOptions
                milestones={milestones ?? []}
                current={task.milestoneId}
                onPick={(milestoneId) => {
                  close();
                  if (milestoneId !== task.milestoneId) change(task, { milestoneId });
                }}
              />
            </MenuGroup>
          )}
        </MenuField>

        <MenuField
          label={t("taskDetail.fields.type")}
          name={t(`taskDetail.types.${task.type}`)}
          value={<span>{t(`taskDetail.types.${task.type}`)}</span>}
          canEdit={canEdit}
          menuLabel={t("taskDetail.fields.typeMenu", { code: task.code })}
        >
          {(close) => (
            <MenuGroup>
              {TASK_TYPES.map((type) => (
                <RadioItem
                  key={type}
                  checked={type === task.type}
                  onSelect={() => {
                    close();
                    if (type !== task.type) change(task, { type });
                  }}
                >
                  {t(`taskDetail.types.${type}`)}
                </RadioItem>
              ))}
            </MenuGroup>
          )}
        </MenuField>

        <MenuField
          label={t("taskDetail.fields.priority")}
          name={t(`taskDetail.priorities.${task.priority}`)}
          value={<PriorityValue priority={task.priority} />}
          canEdit={canEdit}
          menuLabel={t("taskDetail.fields.priorityMenu", { code: task.code })}
        >
          {(close) => (
            <MenuGroup>
              {PRIORITIES.map((priority) => (
                <RadioItem
                  key={priority}
                  checked={priority === task.priority}
                  onSelect={() => {
                    close();
                    if (priority !== task.priority) change(task, { priority });
                  }}
                >
                  <PriorityValue priority={priority} />
                </RadioItem>
              ))}
            </MenuGroup>
          )}
        </MenuField>

        <LabelsField task={task} canEdit={canEdit} />

        {(task.source && task.source !== "manual") || task.occurrences > 1 ? (
          <Field label={t("taskDetail.source.label")}>
            <SourceMark source={task.source ?? "manual"} occurrences={task.occurrences} />
          </Field>
        ) : null}
      </dl>
    </header>
  );
}

function EyeIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z" />
      <circle cx="8" cy="8" r="2" fill={filled ? "currentColor" : "none"} />
    </svg>
  );
}
