import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useProjectStatuses,
  useSetProjectStatuses,
  useSetStallThresholds,
  useTasks,
} from "../../data/queries";
import type { Project, StatusFamily } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { Dialog } from "../../tasks-ui/Dialog";
import { MenuGroup, MenuNote, RadioDot, RadioItem } from "../../tasks-ui/Menu";
import { FamilySign } from "../../tasks-ui/StatusLabel";
import { useToast } from "../../tasks-ui/Toast";
import { queryState } from "../home/blocks/BlockSection";
import { SettingsState } from "./SettingsFrame";
import { ghostButton } from "../task/parts";
import { Chevron, MenuButton, primaryButton, secondaryButton } from "../tasks/controls";
import {
  changed,
  draftOf,
  isLastOfFamily,
  removeStatus,
  taskCounts,
  toRequest,
  type DraftStatus,
  type StatusDraft,
} from "./statusDraft";
import { WhoCanLink } from "../../components/WhoCanLink";

const FAMILIES: StatusFamily[] = ["todo", "active", "closed"];

const nameInputClass =
  "h-8 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-md text-ink placeholder:text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:border-rule-strong focus-visible:border-transparent aria-invalid:border-critical";

const thresholdInputClass =
  "num h-8 w-16 rounded-md border border-rule-strong bg-transparent px-2 text-right text-md text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:border-ink/40 focus-visible:border-transparent aria-invalid:border-critical";

let nextKey = 0;

/**
 * Settings → Statuses (spec «Stati per progetto», §7 «Ferme»): gli
 * stati del progetto in ordine — segno e nome della famiglia, nome, quante
 * task ci sono — e le due soglie «Stalled after N days». Con
 * `project.settings.manage` si aggiunge, si rinomina, si cambia famiglia, si
 * riordina (trascinando o con la tastiera) e si elimina; tutto resta una
 * bozza finché non si salva, in un colpo solo. Eliminare uno stato con task
 * chiede dove spostarle; l'ultimo stato di una famiglia non si toglie (ogni
 * progetto ne ha almeno uno per famiglia) e lo si dice. Senza il permesso,
 * sola lettura e la frase che dice chi può.
 */
export function ProjectStatusesSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const toast = useToast();
  const statuses = useProjectStatuses(project.id);
  const tasks = useTasks({ projectIds: [project.id] });
  const saveStatuses = useSetProjectStatuses();
  const saveThresholds = useSetStallThresholds();
  const canManage = can(viewer, "project.settings.manage", project.id);

  const [edit, setEdit] = useState<StatusDraft | null>(null);
  const [thresholds, setThresholds] = useState<{ activeDays: string; todoDays: string } | null>(
    null,
  );
  const [tried, setTried] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DraftStatus | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const instructionsId = useId();
  const activeId = useId();
  const todoId = useId();

  const saved = statuses.data ?? [];
  const draft = edit ?? draftOf(saved);
  const countById = useMemo(() => {
    const m = new Map<string, number>();
    for (const task of tasks.data ?? []) m.set(task.statusId, (m.get(task.statusId) ?? 0) + 1);
    return m;
  }, [tasks.data]);
  const counts = taskCounts(draft, countById);
  const days = thresholds ?? {
    activeDays: String(project.stallThresholds.activeDays),
    todoDays: String(project.stallThresholds.todoDays),
  };
  const validDays = (v: string) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 365;
  const thresholdsChanged =
    Number(days.activeDays) !== project.stallThresholds.activeDays ||
    Number(days.todoDays) !== project.stallThresholds.todoDays;
  const statusesChanged = changed(draft, saved);
  const dirty = statusesChanged || thresholdsChanged;
  const namesOk = draft.statuses.every((s) => s.name.trim());
  const saving = saveStatuses.isPending || saveThresholds.isPending;

  const update = (next: StatusDraft) => {
    setEdit(next);
    setBlocked(null);
  };
  const discard = () => {
    setEdit(null);
    setThresholds(null);
    setTried(false);
    setBlocked(null);
  };

  const save = async () => {
    setTried(true);
    if (!namesOk || !validDays(days.activeDays) || !validDays(days.todoDays)) return;
    try {
      if (statusesChanged) {
        const { statuses: list, reassign } = toRequest(draft);
        await saveStatuses.mutateAsync({ projectId: project.id, statuses: list, reassign });
      }
    } catch {
      toast.error(t("settings.statuses.saveFailed"));
      return;
    }
    setEdit(null);
    try {
      if (thresholdsChanged) {
        await saveThresholds.mutateAsync({
          projectId: project.id,
          thresholds: { activeDays: Number(days.activeDays), todoDays: Number(days.todoDays) },
        });
      }
    } catch {
      toast.error(
        statusesChanged
          ? t("settings.statuses.thresholdsFailedAfter")
          : t("settings.statuses.thresholdsFailed"),
      );
      return;
    }
    setThresholds(null);
    setTried(false);
    toast.show(t("settings.statuses.saved"));
  };

  const familyName = (f: StatusFamily) => t(`taskUi.families.${f}`);
  const nameOf = (s: DraftStatus) => s.name.trim() || t("settings.statuses.untitled");

  const askDelete = (status: DraftStatus) => {
    if (isLastOfFamily(draft, status.key)) {
      setBlocked(status.key);
      return;
    }
    if ((counts.get(status.key) ?? 0) > 0) {
      setDeleting(status);
      return;
    }
    remove(status, null);
  };
  const remove = (status: DraftStatus, target: string | null) => {
    const index = draft.statuses.findIndex((s) => s.key === status.key);
    update(removeStatus(draft, status.key, target));
    setDeleting(null);
    const into = target ? draft.statuses.find((s) => s.key === target) : null;
    setAnnouncement(
      into
        ? t("settings.statuses.removedMoved", { name: nameOf(status), into: nameOf(into) })
        : t("settings.statuses.removed", { name: nameOf(status) }),
    );
    requestAnimationFrame(() => {
      const handles = listRef.current?.querySelectorAll<HTMLElement>("[data-status-name]");
      handles?.[Math.min(index, (handles?.length ?? 1) - 1)]?.focus();
    });
  };
  const add = () => {
    const key = `new-${++nextKey}`;
    update({ ...draft, statuses: [...draft.statuses, { key, name: "", family: "active" }] });
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(`[data-status-name="${key}"]`)?.focus(),
    );
  };
  const patch = (key: string, change: Partial<DraftStatus>) =>
    update({
      ...draft,
      statuses: draft.statuses.map((s) => (s.key === key ? { ...s, ...change } : s)),
    });

  // --- riordino: trascinamento (dnd-kit) e tastiera, annunciati coi nomi veri --
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const keys = draft.statuses.map((s) => s.key);
  const at = (id: unknown) => keys.indexOf(String(id));
  const titleOf = (id: unknown) => {
    const s = draft.statuses[at(id)];
    return s ? nameOf(s) : "";
  };
  const total = keys.length;
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t("settings.statuses.picked", { name: titleOf(active.id), position: at(active.id) + 1, total }),
    onDragOver: ({ active, over }) =>
      over
        ? t("settings.statuses.moved", { name: titleOf(active.id), position: at(over.id) + 1, total })
        : undefined,
    onDragEnd: ({ active, over }) =>
      t("settings.statuses.dropped", {
        name: titleOf(active.id),
        position: (over ? at(over.id) : at(active.id)) + 1,
        total,
      }),
    onDragCancel: ({ active }) =>
      t("settings.statuses.cancelled", { name: titleOf(active.id), position: at(active.id) + 1 }),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    update({ ...draft, statuses: arrayMove(draft.statuses, at(active.id), at(over.id)) });
  };
  const [picked, setPicked] = useState<{ key: string; from: number } | null>(null);
  const handleOf = (key: string) =>
    listRef.current?.querySelector<HTMLElement>(`[data-status-handle="${key}"]`) ?? null;
  const onHandleKey = (e: KeyboardEvent, index: number) => {
    const status = draft.statuses[index]!;
    const say = (k: string, position: number) =>
      setAnnouncement(t(k, { name: nameOf(status), position, total }));
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (picked?.key === status.key) {
        setPicked(null);
        say("settings.statuses.dropped", index + 1);
      } else {
        setPicked({ key: status.key, from: index });
        say("settings.statuses.picked", index + 1);
      }
      return;
    }
    if (picked?.key !== status.key) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const to = index + (e.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= total) return;
      update({ ...draft, statuses: arrayMove(draft.statuses, index, to) });
      say("settings.statuses.moved", to + 1);
      requestAnimationFrame(() => handleOf(status.key)?.focus());
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      update({ ...draft, statuses: arrayMove(draft.statuses, index, picked.from) });
      setPicked(null);
      say("settings.statuses.cancelled", picked.from + 1);
      requestAnimationFrame(() => handleOf(status.key)?.focus());
    }
  };
  const onHandleBlur = (key: string) =>
    requestAnimationFrame(() => {
      if (document.activeElement === handleOf(key)) return;
      setPicked((current) => (current?.key === key ? null : current));
    });

  const firstTodo = draft.statuses.find((s) => s.family === "todo")?.key;
  const state = queryState([statuses, tasks]);

  return (
    <SettingsState state={state} error={t("settings.statuses.loadError")}>
      <p className="max-w-[72ch] pb-4 text-sm text-ink-muted">
        {t("settings.statuses.intro")}
        {!canManage && (
          <>
            {" "}
            {t("settings.statuses.readOnly")}{" "}
            <WhoCanLink
              action="manageProjectSettings"
              projectId={project.id}
              projectCode={project.code}
            />
          </>
        )}
      </p>
      <p id={instructionsId} className="sr-only">
        {t("settings.statuses.instructions")}
      </p>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{ announcements }}
      >
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          <ul ref={listRef} aria-label={t("settings.statuses.list")} className="border-t border-rule">
            {draft.statuses.map((status, index) => (
              <StatusRow
                key={status.key}
                status={status}
                count={counts.get(status.key) ?? 0}
                birth={status.key === firstTodo}
                canManage={canManage}
                last={isLastOfFamily(draft, status.key)}
                blocked={blocked === status.key}
                picked={picked?.key === status.key}
                invalid={tried && !status.name.trim()}
                describedBy={instructionsId}
                onRename={(name) => patch(status.key, { name })}
                onFamily={(family) => patch(status.key, { family })}
                onDelete={() => askDelete(status)}
                onHandleKey={(e) => onHandleKey(e, index)}
                onHandleBlur={() => onHandleBlur(status.key)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {canManage && (
        <div className="pt-2">
          <button type="button" className={ghostButton} onClick={add}>
            {t("settings.statuses.add")}
          </button>
        </div>
      )}

      <div className="mt-6 border-t border-rule pt-4">
        <h2 className="text-lg font-semibold text-ink">{t("settings.statuses.stalledTitle")}</h2>
        <p className="max-w-[72ch] pt-1 pb-3 text-sm text-ink-muted">
          {t("settings.statuses.stalledIntro")}
        </p>
        <dl className="flex flex-col">
          {(
            [
              ["activeDays", activeId, "active"],
              ["todoDays", todoId, "todo"],
            ] as const
          ).map(([field, id, family]) => (
            <div
              key={field}
              className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule py-1.5 pl-4"
            >
              <dt className="flex min-w-0 flex-1 basis-64 items-center gap-2 text-md text-ink">
                <FamilySign family={family} />
                <label htmlFor={id}>{t(`settings.statuses.threshold.${family}`)}</label>
              </dt>
              <dd className="flex items-center gap-2 text-sm text-ink-muted">
                {t("settings.statuses.stalledAfter")}
                {canManage ? (
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={365}
                    value={days[field]}
                    aria-invalid={tried && !validDays(days[field])}
                    onChange={(e) => setThresholds({ ...days, [field]: e.target.value })}
                    className={thresholdInputClass}
                  />
                ) : (
                  <span id={id} className="num text-md font-semibold text-ink">
                    {days[field]}
                  </span>
                )}
                {t("settings.statuses.daysUnit", { count: Number(days[field]) || 0 })}
              </dd>
            </div>
          ))}
        </dl>
        {tried && (!validDays(days.activeDays) || !validDays(days.todoDays)) && (
          <p className="pt-2 pl-4 text-xs text-critical">{t("settings.statuses.daysInvalid")}</p>
        )}
      </div>

      {canManage && (
        <div className="sticky bottom-0 mt-6 flex flex-wrap items-center gap-2 border-t border-rule bg-ground py-3">
          <p className="min-w-0 flex-1 text-sm text-ink-muted">
            {tried && !namesOk ? (
              <span className="text-critical">{t("settings.statuses.namesMissing")}</span>
            ) : dirty ? (
              t("settings.statuses.unsaved")
            ) : (
              t("settings.statuses.allSaved")
            )}
          </p>
          <button
            type="button"
            className={`${secondaryButton} disabled:pointer-events-none disabled:opacity-40`}
            disabled={!dirty || saving}
            onClick={discard}
          >
            {t("settings.statuses.discard")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:pointer-events-none disabled:opacity-40`}
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {t("settings.statuses.save")}
          </button>
        </div>
      )}

      {deleting && (
        <DeleteStatusDialog
          status={deleting}
          count={counts.get(deleting.key) ?? 0}
          others={draft.statuses.filter((s) => s.key !== deleting.key)}
          nameOf={nameOf}
          familyName={familyName}
          onCancel={() => setDeleting(null)}
          onConfirm={(target) => remove(deleting, target)}
        />
      )}
    </SettingsState>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="currentColor" aria-hidden="true" focusable="false">
      {[4, 8, 12].flatMap((y) =>
        [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.1} />),
      )}
    </svg>
  );
}

/**
 * Uno stato: maniglia · nome (un campo, per rinominare sul posto) · famiglia
 * (menu) · quante task · «Delete». «New tasks start here» sul primo stato da
 * fare: è quello di nascita. In sola lettura restano nome, famiglia e task.
 */
function StatusRow({
  status,
  count,
  birth,
  canManage,
  last,
  blocked,
  picked,
  invalid,
  describedBy,
  onRename,
  onFamily,
  onDelete,
  onHandleKey,
  onHandleBlur,
}: {
  status: DraftStatus;
  count: number;
  birth: boolean;
  canManage: boolean;
  last: boolean;
  blocked: boolean;
  picked: boolean;
  invalid: boolean;
  describedBy: string;
  onRename: (name: string) => void;
  onFamily: (family: StatusFamily) => void;
  onDelete: () => void;
  onHandleKey: (e: KeyboardEvent) => void;
  onHandleBlur: () => void;
}) {
  const { t } = useTranslation();
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: status.key,
    disabled: !canManage,
  });
  const name = status.name.trim() || t("settings.statuses.untitled");
  const family = t(`taskUi.families.${status.family}`);
  return (
    <li
      ref={setNodeRef}
      data-status-row={status.key}
      data-status-family={status.family}
      style={{
        transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
        transition,
      }}
      className={`relative border-b border-rule bg-ground ${picked || isDragging ? "z-10 bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]" : ""}`}
    >
      <div className="flex h-11 items-center gap-3 pr-2 pl-1">
        {canManage ? (
          <button
            type="button"
            data-status-handle={status.key}
            aria-label={t("settings.statuses.handle", { name })}
            aria-describedby={describedBy}
            aria-pressed={picked}
            onKeyDown={onHandleKey}
            onBlur={onHandleBlur}
            {...listeners}
            className={`grid size-8 shrink-0 cursor-grab touch-none place-items-center rounded-md text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:cursor-grabbing ${picked ? "bg-ink/10 text-ink" : ""}`}
          >
            <GripIcon />
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {canManage ? (
            <input
              data-status-name={status.key}
              value={status.name}
              maxLength={40}
              aria-label={t("settings.statuses.nameLabel")}
              aria-invalid={invalid}
              placeholder={t("settings.statuses.namePlaceholder")}
              onChange={(e) => onRename(e.target.value)}
              className={`${nameInputClass} max-w-72`}
            />
          ) : (
            <span className="min-w-0 truncate px-2 text-md text-ink">{status.name}</span>
          )}
          {birth && (
            <span className="shrink-0 truncate text-xs text-ink-faint">
              {t("settings.statuses.birth")}
            </span>
          )}
        </span>
        {canManage ? (
          <MenuButton
            menuLabel={t("settings.statuses.familyOf", { name })}
            ariaLabel={t("settings.statuses.familyButton", { name, family })}
            align="right"
            className="inline-flex h-8 w-36 items-center gap-2 rounded-md px-2 text-sm text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/8"
            label={
              <>
                <FamilySign family={status.family} />
                <span className="min-w-0 flex-1 truncate text-left">{family}</span>
                <Chevron />
              </>
            }
          >
            {(close) =>
              last ? (
                <MenuGroup>
                  <RadioItem checked onSelect={close}>
                    <FamilySign family={status.family} />
                    {family}
                  </RadioItem>
                  <MenuNote>{t("settings.statuses.lastFamilyNote", { family })}</MenuNote>
                </MenuGroup>
              ) : (
                <MenuGroup label={t("settings.statuses.family")}>
                  {FAMILIES.map((f) => (
                    <RadioItem
                      key={f}
                      checked={f === status.family}
                      onSelect={() => {
                        close();
                        onFamily(f);
                      }}
                    >
                      <FamilySign family={f} />
                      {t(`taskUi.families.${f}`)}
                    </RadioItem>
                  ))}
                </MenuGroup>
              )
            }
          </MenuButton>
        ) : (
          <span className="flex w-36 items-center gap-2 px-2 text-sm text-ink-muted">
            <FamilySign family={status.family} />
            {family}
          </span>
        )}
        <span className="num w-20 shrink-0 text-right text-sm text-ink-muted">
          {count > 0 ? t("settings.statuses.tasks", { count }) : (
            <span className="text-ink-faint">{t("settings.statuses.noTasks")}</span>
          )}
        </span>
        {canManage && (
          <button
            type="button"
            aria-label={t("settings.statuses.deleteLabel", { name })}
            aria-describedby={blocked ? `blocked-${status.key}` : undefined}
            className={ghostButton}
            onClick={onDelete}
          >
            {t("settings.statuses.delete")}
          </button>
        )}
      </div>
      {blocked && (
        <p
          id={`blocked-${status.key}`}
          role="alert"
          className="mb-2 ml-12 rounded-md bg-ink/4 px-2.5 py-2 text-sm text-ink"
        >
          {t("settings.statuses.lastFamily", { family, name })}
        </p>
      )}
    </li>
  );
}

/**
 * «Delete “In review”?»: le sue task devono andare da qualche parte. Si
 * sceglie fra gli altri stati della bozza (anche quelli appena aggiunti);
 * proposto il primo della stessa famiglia. Niente cambia finché non si salva.
 */
function DeleteStatusDialog({
  status,
  count,
  others,
  nameOf,
  familyName,
  onCancel,
  onConfirm,
}: {
  status: DraftStatus;
  count: number;
  others: DraftStatus[];
  nameOf: (s: DraftStatus) => string;
  familyName: (f: StatusFamily) => string;
  onCancel: () => void;
  onConfirm: (target: string) => void;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState(
    (others.find((s) => s.family === status.family) ?? others[0])!.key,
  );
  const name = nameOf(status);
  return (
    <Dialog
      title={t("settings.statuses.deleteTitle", { name })}
      description={t("settings.statuses.deleteBody", { count, name })}
      onClose={onCancel}
      width={440}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onCancel}>
            {t("taskDetail.cancel")}
          </button>
          <button type="button" className={primaryButton} onClick={() => onConfirm(target)}>
            {t("settings.statuses.deleteConfirm", { count })}
          </button>
        </>
      }
    >
      <fieldset className="flex flex-col">
        <legend className="pb-1.5 text-sm font-medium text-ink">
          {t("settings.statuses.moveTo", { count })}
        </legend>
        <div className="flex flex-col">
          {others.map((s, i) => (
            <label
              key={s.key}
              className="flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-md text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus"
            >
              <input
                type="radio"
                name="move-to"
                value={s.key}
                checked={target === s.key}
                data-autofocus={target === s.key || (i === 0 && !target) ? true : undefined}
                onChange={() => setTarget(s.key)}
                className="sr-only"
              />
              <RadioDot checked={target === s.key} />
              <FamilySign family={s.family} />
              <span className="min-w-0 truncate">{nameOf(s)}</span>
              <span className="ml-auto shrink-0 text-xs text-ink-faint">{familyName(s.family)}</span>
            </label>
          ))}
        </div>
        <p className="pt-2 text-xs text-ink-muted">{t("settings.statuses.deleteNote")}</p>
      </fieldset>
    </Dialog>
  );
}
