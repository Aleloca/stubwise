import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useCreateMilestone,
  useDeleteMilestone,
  useMilestones,
  useTasks,
  useUpdateMilestone,
} from "../../data/queries";
import type { Milestone } from "../../data/types";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { MenuGroup, itemClass } from "../../tasks-ui/Menu";
import { PageError, PageSkeleton } from "../../tasks-ui/PageStates";
import { DueDate } from "../../tasks-ui/TaskRow";
import {
  InlineConfirm,
  MoreIcon,
  PlusIcon,
  ghostButton,
  smallPrimary,
  smallSecondary,
} from "../task/parts";
import { MenuButton, secondaryButton } from "../tasks/controls";
import { TODAY } from "../../data/dates";
import { openMilestones } from "../../domain/due";
import { AutomationOriginLine } from "../automations/AutomationOrigin";

type Editing = { kind: "new" } | { kind: "edit"; id: string } | { kind: "delete"; id: string };

/**
 * «Manage milestones» (`tickets.edit`): i traguardi del progetto, aperti
 * poi chiusi; per ognuno modifica, chiudi/riapri, elimina (con conferma in
 * linea: le task restano, senza traguardo). «New milestone» apre il modulo
 * in testa all'elenco. Ogni scrittura dice nel dialogo se non è riuscita.
 */
export function MilestonesDialog({
  projectId,
  startWithNew,
  onClose,
}: {
  projectId: string;
  startWithNew: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const milestones = useMilestones(projectId);
  const tasks = useTasks({ projectIds: [projectId] }).data;
  const create = useCreateMilestone();
  const update = useUpdateMilestone();
  const remove = useDeleteMilestone();
  const [editing, setEditing] = useState<Editing | null>(startWithNew ? { kind: "new" } : null);
  const [error, setError] = useState<string | null>(null);

  const list = milestones.data ?? [];
  const open = openMilestones(list);
  const closed = list.filter((m) => m.closed).sort((a, b) => a.name.localeCompare(b.name));
  const taskCount = (id: string) => (tasks ?? []).filter((x) => x.milestoneId === id).length;
  const failed = () => setError(t("overview.milestones.failed"));
  const done = () => {
    setError(null);
    setEditing(null);
  };

  let body;
  if (milestones.isError) {
    body = (
      <PageError
        message={t("overview.milestones.error")}
        onRetry={() => void milestones.refetch()}
      />
    );
  } else if (!milestones.data) {
    body = <PageSkeleton rows={3} />;
  } else {
    const row = (m: Milestone) => {
      if (editing?.kind === "edit" && editing.id === m.id) {
        return (
          <li key={m.id} className="border-b border-rule py-3">
            <MilestoneForm
              initial={m}
              pending={update.isPending}
              onCancel={() => setEditing(null)}
              onSave={(input) =>
                update.mutate({ id: m.id, patch: input }, { onSuccess: done, onError: failed })
              }
            />
          </li>
        );
      }
      if (editing?.kind === "delete" && editing.id === m.id) {
        const count = taskCount(m.id);
        return (
          <li key={m.id} className="border-b border-rule py-2">
            <InlineConfirm
              message={
                count > 0
                  ? t("overview.milestones.deleteConfirm", { name: m.name, count })
                  : t("overview.milestones.deleteConfirmEmpty", { name: m.name })
              }
              confirm={t("overview.milestones.delete")}
              cancelLabel={t("overview.cancel")}
              onCancel={() => setEditing(null)}
              onConfirm={() => remove.mutate(m.id, { onSuccess: done, onError: failed })}
            />
          </li>
        );
      }
      return (
        <li
          key={m.id}
          data-manage-milestone={m.id}
          className="flex min-h-10 items-center gap-3 border-b border-rule py-1.5"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`truncate text-md ${m.closed ? "text-ink-muted" : "text-ink"}`}>
              {m.name}
            </span>
            {m.closed && (
              <span className="text-xs text-ink-muted">{t("overview.milestones.closed")}</span>
            )}
            {m.automationRef && (
              <AutomationOriginLine
                automationRef={m.automationRef}
                createdCode={m.id}
                kind="milestone"
                className="text-xs text-ink-muted"
              />
            )}
          </span>
          <span className="w-16 shrink-0">
            {m.dueDate ? (
              <DueDate date={m.dueDate} overdue={!m.closed && m.dueDate < TODAY} />
            ) : (
              <span className="block text-right text-xs text-ink-faint">
                {t("overview.milestones.noDate")}
              </span>
            )}
          </span>
          <MenuButton
            label={<MoreIcon />}
            ariaLabel={t("overview.milestones.actions", { name: m.name })}
            title={t("overview.milestones.actions", { name: m.name })}
            menuLabel={t("overview.milestones.actions", { name: m.name })}
            align="right"
            className={`${ghostButton} w-8 justify-center px-0`}
          >
            {(close) => (
              <MenuGroup>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    setEditing({ kind: "edit", id: m.id });
                  }}
                >
                  {t("overview.milestones.edit")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    close();
                    update.mutate(
                      { id: m.id, patch: { closed: !m.closed } },
                      { onSuccess: done, onError: failed },
                    );
                  }}
                >
                  {m.closed ? t("overview.milestones.reopen") : t("overview.milestones.close")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`${itemClass} text-critical`}
                  onClick={() => {
                    close();
                    setEditing({ kind: "delete", id: m.id });
                  }}
                >
                  {t("overview.milestones.delete")}
                </button>
              </MenuGroup>
            )}
          </MenuButton>
        </li>
      );
    };
    body = (
      <div className="flex flex-col gap-4">
        {editing?.kind === "new" ? (
          <div className="rounded-md border border-rule p-3">
            <MilestoneForm
              pending={create.isPending}
              onCancel={() => setEditing(null)}
              onSave={(input) =>
                create.mutate({ projectId, input }, { onSuccess: done, onError: failed })
              }
            />
          </div>
        ) : (
          <button
            type="button"
            className={`${ghostButton} self-start`}
            onClick={() => setEditing({ kind: "new" })}
          >
            <PlusIcon />
            {t("overview.milestones.new")}
          </button>
        )}
        {list.length === 0 ? (
          <p className="text-md text-ink-muted">{t("overview.milestones.none")}</p>
        ) : (
          <>
            {open.length > 0 && (
              <section aria-label={t("overview.milestones.openGroup")}>
                <h3 className="heading-group pb-1">{t("overview.milestones.openGroup")}</h3>
                <ul className="border-t border-rule">{open.map(row)}</ul>
              </section>
            )}
            {closed.length > 0 && (
              <section aria-label={t("overview.milestones.closedGroup")}>
                <h3 className="heading-group pb-1">{t("overview.milestones.closedGroup")}</h3>
                <ul className="border-t border-rule">{closed.map(row)}</ul>
              </section>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <Dialog
      title={t("overview.milestones.dialogTitle")}
      description={t("overview.milestones.dialogDescription")}
      onClose={onClose}
      width={560}
      footer={
        <button type="button" className={secondaryButton} onClick={onClose}>
          {t("overview.milestones.done")}
        </button>
      }
    >
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
      {body}
    </Dialog>
  );
}

/** Nome (obbligatorio), scadenza (facoltativa), descrizione. */
function MilestoneForm({
  initial,
  pending,
  onSave,
  onCancel,
}: {
  initial?: Milestone;
  pending: boolean;
  onSave: (input: { name: string; dueDate: string | null; description: string }) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [tried, setTried] = useState(false);
  const nameId = useId();
  const dueId = useId();
  const descriptionId = useId();
  const missing = tried && !name.trim();
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!name.trim()) return;
        onSave({ name: name.trim(), dueDate: dueDate || null, description });
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_160px] gap-3">
        <DialogField label={t("overview.milestones.name")} htmlFor={nameId}>
          <input
            id={nameId}
            data-autofocus
            value={name}
            aria-invalid={missing}
            onChange={(e) => setName(e.target.value)}
            className={`${inputClass} ${missing ? "border-critical" : ""}`}
          />
          {missing && (
            <span className="text-xs text-critical">{t("overview.milestones.nameMissing")}</span>
          )}
        </DialogField>
        <DialogField label={t("overview.milestones.due")} htmlFor={dueId}>
          <input
            id={dueId}
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={`${inputClass} num`}
          />
        </DialogField>
      </div>
      <DialogField
        label={t("overview.milestones.description")}
        htmlFor={descriptionId}
        hint={t("overview.optional")}
      >
        <textarea
          id={descriptionId}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`${inputClass} resize-y`}
        />
      </DialogField>
      <div className="flex justify-end gap-2">
        <button type="button" className={smallSecondary} onClick={onCancel}>
          {t("overview.cancel")}
        </button>
        <button type="submit" className={smallPrimary} disabled={pending}>
          {initial ? t("overview.milestones.save") : t("overview.milestones.create")}
        </button>
      </div>
    </form>
  );
}
