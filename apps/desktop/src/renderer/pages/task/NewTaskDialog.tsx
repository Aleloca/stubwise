import { useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useConvertRequest,
  useCreateTask,
  useDepartments,
  useMilestones,
  usePeople,
  useProjects,
  useProjectStatuses,
  useRequest,
} from "../../data/queries";
import type { Project, Task, TaskSize } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { weekLabel } from "../../domain/weeks";
import { Dialog, DialogField, inputClass, selectButtonClass } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { PersonChip } from "../../tasks-ui/PersonChip";
import { StatusLabel } from "../../tasks-ui/StatusLabel";
import { Chevron, MenuButton, primaryButton, secondaryButton } from "../tasks/controls";
import {
  AssigneeOptions,
  MilestoneOptions,
  SizeOptions,
  StatusOptions,
  WeekOptions,
  shortWeek,
  useProjectMembers,
} from "../tasks/pickers";

/** I progetti dove chi guarda può creare task (`tickets.create`), per codice. */
function useCreatableProjects(): Project[] | undefined {
  const { viewer } = useViewer();
  const projects = useProjects().data;
  return projects
    ?.filter((p) => can(viewer, "tickets.create", p.id))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Un campo-menu del modulo: etichetta sopra, il valore nel bottone. */
function SelectField({
  label,
  value,
  valueText,
  placeholder,
  menuLabel,
  invalid = false,
  disabled = false,
  children,
}: {
  label: string;
  value: ReactNode | null;
  /** Il valore a parole, per il nome accessibile («Project: MKX Campagne…»). */
  valueText?: string;
  placeholder: string;
  menuLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  return (
    <DialogField label={label}>
      <MenuButton
        menuLabel={menuLabel ?? label}
        ariaLabel={`${label}: ${value ? (valueText ?? "") : placeholder}`}
        wrapperClassName="flex w-full min-w-0"
        disabled={disabled}
        className={`${selectButtonClass} disabled:opacity-50 ${invalid ? "border-critical" : ""}`}
        label={
          <>
            <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
              {value ?? <span className="text-ink-faint">{placeholder}</span>}
            </span>
            <Chevron />
          </>
        }
      >
        {children}
      </MenuButton>
    </DialogField>
  );
}

/**
 * «New task»: titolo, progetto (preselezionato se si arriva da un progetto
 * dove si può creare; altrimenti si sceglie fra quelli con `tickets.create`),
 * reparto (proposto: il primo di chi crea), descrizione, assegnatario,
 * taglia, stato iniziale (il primo «da fare»), settimana, traguardo. Gli
 * ultimi dipendono dal progetto: cambiarlo li riporta al loro default.
 * `fromRequestId` lega la task alla richiesta da cui nasce: titolo,
 * descrizione e progetto partono dalla richiesta (il progetto resta quello),
 * e creare la task porta la richiesta a «trasformata».
 */
export function NewTaskDialog({
  projectId,
  fromRequestId,
  onCreated,
  onClose,
}: {
  projectId?: string;
  fromRequestId?: string;
  onCreated: (task: Task) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { viewer } = useViewer();
  const projects = useCreatableProjects();
  const departments = useDepartments().data;
  const me = usePeople().data?.find((p) => p.id === viewer.personId);
  const create = useCreateTask();
  const convert = useConvertRequest();
  const request = useRequest(fromRequestId ?? "", { enabled: !!fromRequestId }).data;
  const titleId = useId();
  const descriptionId = useId();

  // Il progetto passato vale solo se chi guarda ci può creare: altrimenti si sceglie.
  const allowed = projectId && can(viewer, "tickets.create", projectId) ? projectId : null;
  const [chosenProject, setProject] = useState<string | null>(allowed);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [departmentId, setDepartment] = useState<string | null>(null);
  const [assigneeId, setAssignee] = useState<string | null>(null);
  const [size, setSize] = useState<TaskSize | null>(null);
  const [statusId, setStatus] = useState<string | null>(null);
  const [week, setWeek] = useState<string | null>(null);
  const [milestoneId, setMilestone] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [failed, setFailed] = useState(false);
  // La richiesta arriva dopo il primo disegno: i campi si riempiono una volta.
  const [seeded, setSeeded] = useState(false);
  if (request && !seeded) {
    setSeeded(true);
    setTitle(request.title);
    setDescription(request.description);
    setSize(request.size ?? null);
    if (can(viewer, "tickets.create", request.projectId)) setProject(request.projectId);
  }
  const pending = create.isPending || convert.isPending;

  const project = projects?.find((p) => p.id === chosenProject);
  const statuses = useProjectStatuses(project?.id ?? "").data;
  const members = useProjectMembers(project?.id);
  const milestones = useMilestones(project?.id ?? "__none__").data;
  const firstTodo = statuses?.find((s) => s.family === "todo");
  const status = statuses?.find((s) => s.id === (statusId ?? firstTodo?.id));
  const department =
    departments?.find((d) => d.id === departmentId) ??
    departments?.find((d) => d.id === me?.departmentIds[0]);
  const milestone = milestones?.find((m) => m.id === milestoneId);

  const pickProject = (id: string) => {
    if (id === chosenProject) return;
    setProject(id);
    setStatus(null);
    setAssignee(null);
    setMilestone(null);
  };

  const submit = () => {
    setTried(true);
    if (!project || !title.trim()) return;
    setFailed(false);
    const input = {
      title: title.trim(),
      description: description.trim() || undefined,
      departmentId: department?.id,
      assigneeId,
      size,
      statusId: status?.id,
      plannedWeek: week,
      milestoneId,
    };
    const callbacks = { onSuccess: onCreated, onError: () => setFailed(true) };
    if (fromRequestId) {
      convert.mutate({ id: fromRequestId, input }, callbacks);
    } else {
      create.mutate({ ...input, projectId: project.id, requestId: null }, callbacks);
    }
  };

  const noProjects = projects !== undefined && projects.length === 0;

  return (
    <Dialog
      title={t("newTask.title")}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("taskDetail.cancel")}
          </button>
          <button
            type="submit"
            form="new-task"
            className={primaryButton}
            disabled={pending || noProjects}
          >
            {t("newTask.submit")}
          </button>
        </>
      }
    >
      <form
        id="new-task"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DialogField label={t("newTask.fields.title")} htmlFor={titleId}>
          <input
            id={titleId}
            data-autofocus
            value={title}
            aria-invalid={tried && !title.trim()}
            placeholder={t("newTask.fields.titlePlaceholder")}
            onChange={(e) => setTitle(e.target.value)}
            className={`${inputClass} text-lg font-medium ${tried && !title.trim() ? "border-critical" : ""}`}
          />
          {tried && !title.trim() && (
            <span className="text-xs text-critical">{t("newTask.titleMissing")}</span>
          )}
        </DialogField>

        <div className="grid grid-cols-2 gap-x-3 gap-y-4">
          <SelectField
            label={t("newTask.fields.project")}
            valueText={project ? `${project.code} ${project.name}` : undefined}
            menuLabel={t("newTask.fields.project")}
            value={
              project ? (
                <>
                  <span className="num shrink-0 text-xs font-semibold text-ink-muted">{project.code}</span>
                  <span className="truncate">{project.name}</span>
                </>
              ) : null
            }
            placeholder={noProjects ? t("newTask.noProjects") : t("newTask.chooseProject")}
            invalid={tried && !project}
            disabled={noProjects || !!fromRequestId}
          >
            {(close) => (
              <MenuGroup>
                {(projects ?? []).map((p) => (
                  <RadioItem
                    key={p.id}
                    checked={p.id === chosenProject}
                    onSelect={() => {
                      close();
                      pickProject(p.id);
                    }}
                  >
                    <span className="num w-9 shrink-0 text-xs font-semibold text-ink-muted">{p.code}</span>
                    <span className="min-w-0 truncate">{p.name}</span>
                  </RadioItem>
                ))}
              </MenuGroup>
            )}
          </SelectField>

          <SelectField
            label={t("newTask.fields.department")}
            valueText={department?.name}
            value={
              department ? (
                <>
                  <span
                    aria-hidden="true"
                    className="h-3 w-[3px] shrink-0 rounded-[1px]"
                    style={{ background: `var(${department.colorToken})` }}
                  />
                  <span className="truncate">{department.name}</span>
                </>
              ) : null
            }
            placeholder={t("taskUi.states.loading")}
          >
            {(close) => (
              <MenuGroup>
                {(departments ?? []).map((d) => (
                  <RadioItem
                    key={d.id}
                    checked={d.id === department?.id}
                    onSelect={() => {
                      close();
                      setDepartment(d.id);
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
          </SelectField>
        </div>
        {tried && !project && !noProjects && (
          <span className="-mt-2 text-xs text-critical">{t("newTask.projectMissing")}</span>
        )}

        <DialogField label={t("newTask.fields.description")} htmlFor={descriptionId} hint={t("newTask.markdown")}>
          <textarea
            id={descriptionId}
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`${inputClass} resize-y`}
          />
        </DialogField>

        <div className="grid grid-cols-2 gap-x-3 gap-y-4 border-t border-rule pt-4">
          <SelectField
            label={t("newTask.fields.assignee")}
            valueText={members?.find((p) => p.id === assigneeId)?.name ?? t("taskUi.unassigned")}
            value={<PersonChip personId={assigneeId} />}
            placeholder={t("taskUi.unassigned")}
            disabled={!project}
          >
            {(close) => (
              <MenuGroup>
                <AssigneeOptions
                  people={members ?? []}
                  current={assigneeId}
                  onPick={(id) => {
                    close();
                    setAssignee(id);
                  }}
                />
              </MenuGroup>
            )}
          </SelectField>

          <SelectField
            label={t("newTask.fields.status")}
            valueText={status?.name}
            value={status ? <StatusLabel status={status} /> : null}
            placeholder={t("newTask.afterProject")}
            disabled={!project}
          >
            {(close) => (
              <MenuGroup>
                <StatusOptions
                  statuses={statuses ?? []}
                  current={status?.id}
                  onPick={(id) => {
                    close();
                    setStatus(id);
                  }}
                />
              </MenuGroup>
            )}
          </SelectField>

          <SelectField
            label={t("newTask.fields.size")}
            valueText={size ?? undefined}
            value={size ? <span className="num font-semibold">{size}</span> : null}
            placeholder={t("taskUi.size.none")}
          >
            {(close) => (
              <MenuGroup>
                <SizeOptions
                  current={size}
                  onPick={(s) => {
                    close();
                    setSize(s);
                  }}
                />
              </MenuGroup>
            )}
          </SelectField>

          <SelectField
            label={t("newTask.fields.week")}
            valueText={week ? weekLabel(week, i18n.language) : undefined}
            value={
              week ? (
                <span className="num flex min-w-0 items-baseline gap-1.5">
                  <span className="font-semibold">{shortWeek(week)}</span>
                  <span className="truncate text-ink-muted">{weekLabel(week, i18n.language)}</span>
                </span>
              ) : null
            }
            placeholder={t("tasks.bulk.noWeek")}
          >
            {(close) => (
              <MenuGroup>
                <WeekOptions
                  current={week}
                  onPick={(w) => {
                    close();
                    setWeek(w);
                  }}
                />
              </MenuGroup>
            )}
          </SelectField>

          <SelectField
            label={t("newTask.fields.milestone")}
            valueText={milestone?.name}
            value={milestone ? <span className="truncate">{milestone.name}</span> : null}
            placeholder={project ? t("tasks.groups.noMilestone") : t("newTask.afterProject")}
            disabled={!project}
          >
            {(close) => (
              <MenuGroup>
                <MilestoneOptions
                  milestones={milestones ?? []}
                  current={milestoneId}
                  onPick={(id) => {
                    close();
                    setMilestone(id);
                  }}
                />
              </MenuGroup>
            )}
          </SelectField>
        </div>

        {failed && (
          <p role="alert" className="rounded-md bg-critical/10 px-3 py-2 text-sm text-ink">
            {t("newTask.failed")}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * Montato dal layout su `?newTask=1` (con `project=<CODE>` facoltativo), in
 * ogni route: la palette ⌘K e i bottoni «New task» scrivono l'indirizzo, il
 * dialogo si apre sopra la pagina. Creata la task, se ne apre il pannello.
 */
export function NewTaskHost() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { newTask?: string; project?: string };
  const projects = useProjects().data;
  if (search.newTask !== "1") return null;
  // Aspetta i progetti per risolvere il codice; un codice che non si vede vale «nessuno».
  if (search.project && !projects) return null;
  const projectId = search.project
    ? projects?.find((p) => p.code === search.project)?.id
    : undefined;
  const leave = (task?: Task) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        newTask: undefined,
        project: undefined,
        ...(task ? { task: task.code } : {}),
      }),
    } as never);
  return (
    <NewTaskDialog
      // Un altro progetto nell'indirizzo è un dialogo nuovo.
      key={search.project ?? ""}
      projectId={projectId}
      onCreated={(task) => leave(task)}
      onClose={() => leave()}
    />
  );
}
