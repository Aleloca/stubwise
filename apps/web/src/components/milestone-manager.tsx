import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  createMilestone,
  deleteMilestone,
  updateMilestone,
  type MilestonePatch,
  type MilestoneWithCounts,
} from "../lib/api";
import { milestonesQueryOptions } from "../lib/queries";
import { formatDate } from "../lib/format";
import { FormError } from "./field";

interface MilestoneManagerProps {
  projectId: string;
}

/**
 * Gestore delle milestone di un progetto: lista con avanzamento ({completed}/
 * {total} + barra proporzionale), badge open/closed e azioni inline (rinomina,
 * chiudi/riapri, elimina con conferma a due click) + creazione (nome + dueDate
 * opzionale). Ogni mutazione invalida la sola lista del progetto.
 *
 * Vive nel dettaglio progetto (`projects/$slug.tsx`): le milestone sono
 * per-progetto, quindi quella pagina è la loro casa naturale. È montato solo
 * quando il projectId è definito, così la useSuspenseQuery è sempre abilitata.
 */
export function MilestoneManager({ projectId }: MilestoneManagerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: milestones } = useSuspenseQuery(milestonesQueryOptions(projectId));

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: milestonesQueryOptions(projectId).queryKey });

  const [name, setName] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      createMilestone({
        projectId,
        name: name.trim(),
        // L'input date dà "YYYY-MM-DD": lo si normalizza a ISO a mezzogiorno
        // UTC per evitare slittamenti di giorno per fuso; vuoto → null.
        dueDate: dueDate ? new Date(`${dueDate}T12:00:00.000Z`).toISOString() : null,
      }),
    onSuccess: async () => {
      setName("");
      setDueDate("");
      setCreateError(null);
      await invalidate();
    },
    onError: (cause) =>
      setCreateError(cause instanceof Error ? cause.message : t("milestones:createFailed")),
  });

  function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "" || createMutation.isPending) return;
    createMutation.mutate();
  }

  return (
    <div className="space-y-4">
      {milestones.length === 0 ? (
        <p className="font-mono text-[12px] text-fg-faint">{t("milestones:empty")}</p>
      ) : (
        <ul className="space-y-2">
          {milestones.map((milestone) => (
            <MilestoneRow key={milestone.id} milestone={milestone} onChanged={invalidate} />
          ))}
        </ul>
      )}

      <form
        onSubmit={handleCreate}
        className="flex flex-wrap items-end gap-3 border-t border-line pt-4"
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <label htmlFor="milestone-name" className={labelClass}>
            {t("milestones:name")}
          </label>
          <input
            id="milestone-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("milestones:namePlaceholder")}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-[15px] text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="milestone-due" className={labelClass}>
            {t("milestones:dueDate")}
          </label>
          <input
            id="milestone-due"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 font-mono text-[13px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          />
        </div>
        <button
          type="submit"
          disabled={name.trim() === "" || createMutation.isPending}
          className="rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
        >
          {createMutation.isPending ? t("milestones:creating") : t("milestones:create")}
        </button>
      </form>
      <FormError message={createError} />
    </div>
  );
}

const labelClass = "font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase";

function MilestoneRow({
  milestone,
  onChanged,
}: {
  milestone: MilestoneWithCounts;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(milestone.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const patchMutation = useMutation({
    mutationFn: (patch: MilestonePatch) => updateMilestone(milestone.id, patch),
    onSuccess: async () => {
      setRenaming(false);
      await onChanged();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteMilestone(milestone.id),
    onSuccess: () => onChanged(),
  });

  const { total, completed } = milestone.counts;
  const ratio = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isOpen = milestone.status === "open";

  function handleDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    deleteMutation.mutate();
  }

  return (
    <li className="rounded-sm border border-line bg-ink-900 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {renaming ? (
          <div className="flex flex-1 items-center gap-2">
            <input
              aria-label={t("milestones:name")}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              className="flex-1 rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 text-sm text-fg focus-visible:border-signal-dim"
            />
            <button
              type="button"
              disabled={draftName.trim() === "" || patchMutation.isPending}
              onClick={() => patchMutation.mutate({ name: draftName.trim() })}
              className="rounded-sm bg-signal px-2.5 py-1 font-mono text-[11px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:opacity-60"
            >
              {patchMutation.isPending ? t("milestones:saving") : t("milestones:save")}
            </button>
            <button
              type="button"
              onClick={() => {
                setRenaming(false);
                setDraftName(milestone.name);
              }}
              className="font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase transition-colors hover:text-fg-muted"
            >
              {t("milestones:cancel")}
            </button>
          </div>
        ) : (
          <span className="flex-1 text-sm font-medium text-fg">{milestone.name}</span>
        )}

        <span
          className={`rounded-sm border px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.12em] uppercase ${
            isOpen ? "border-signal-dim/50 text-signal" : "border-line-strong text-fg-faint"
          }`}
        >
          {isOpen ? t("milestones:statusOpen") : t("milestones:statusClosed")}
        </span>

        {milestone.dueDate && (
          <span className="font-mono text-[11px] text-fg-muted">
            {formatDate(milestone.dueDate)}
          </span>
        )}
      </div>

      <div
        className="mt-2.5 flex items-center gap-2"
        title={t("milestones:progressLabel", { completed, total })}
      >
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-850">
          <div
            className="h-full bg-signal transition-[width]"
            style={{ width: `${ratio}%` }}
            aria-hidden
          />
        </div>
        <span className="shrink-0 font-mono text-[11px] text-fg-muted">
          {t("milestones:progress", { completed, total })}
        </span>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {!renaming && (
          <button
            type="button"
            onClick={() => {
              setDraftName(milestone.name);
              setRenaming(true);
            }}
            className={actionClass}
          >
            {t("milestones:rename")}
          </button>
        )}
        <button
          type="button"
          disabled={patchMutation.isPending}
          onClick={() => patchMutation.mutate({ status: isOpen ? "closed" : "open" })}
          className={actionClass}
        >
          {isOpen ? t("milestones:close") : t("milestones:reopen")}
        </button>
        <button
          type="button"
          disabled={deleteMutation.isPending}
          aria-pressed={confirmingDelete}
          onClick={handleDelete}
          onBlur={() => setConfirmingDelete(false)}
          className={`font-mono text-[11px] tracking-[0.1em] uppercase transition-colors ${
            confirmingDelete ? "text-danger" : "text-fg-faint hover:text-danger"
          }`}
        >
          {confirmingDelete ? t("milestones:confirmDelete") : t("milestones:delete")}
        </button>
      </div>
    </li>
  );
}

const actionClass =
  "font-mono text-[11px] tracking-[0.1em] text-fg-faint uppercase transition-colors hover:text-fg-muted disabled:opacity-50";
