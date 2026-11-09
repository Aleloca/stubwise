import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { TODAY } from "../../data/dates";
import { usePeople } from "../../data/queries";
import type { Task } from "../../data/types";
import { useViewer } from "../../data/viewer";
import type { Stall } from "../../domain/stalled";
import { inputClass } from "../../tasks-ui/Dialog";
import { StallMark } from "../../tasks-ui/StallMark";
import { useInlineUpdate } from "../tasks/pickers";
import { Section, ghostButton, smallPrimary, smallSecondary } from "./parts";

/**
 * «Stalled»: se la task è ferma, il motivo e da quanti giorni (la stessa
 * frase del segno sulle righe); se il motivo è manuale anche la nota, chi
 * l'ha segnata e «Not stalled anymore». Chi ha `tickets.edit` la segna ferma
 * con un motivo esterno e una nota. Una task non ferma, per chi non può
 * segnarla, non ha la sezione: non c'è niente da dire.
 */
export function StallControl({
  task,
  stall,
  canEdit,
}: {
  task: Task;
  stall: Stall | null;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const people = usePeople().data;
  const change = useInlineUpdate();
  const [form, setForm] = useState<{ reason: string; note: string } | null>(null);
  const reasonId = useId();
  const noteId = useId();
  const manual = task.manualStall;

  if (!stall && !canEdit) return null;

  const mark = () => {
    if (!form?.reason.trim()) return;
    change(task, {
      manualStall: {
        reason: form.reason.trim(),
        note: form.note.trim(),
        since: TODAY,
        byId: viewer.personId,
      },
    });
    setForm(null);
  };

  if (form) {
    return (
      <Section title={t("taskUi.stall.label")}>
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            mark();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setForm(null);
            }
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={reasonId} className="text-sm font-medium text-ink">
              {t("taskDetail.stall.reason")}
            </label>
            <input
              id={reasonId}
              autoFocus
              value={form.reason}
              placeholder={t("taskDetail.stall.reasonPlaceholder")}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={noteId} className="text-sm font-medium text-ink">
              {t("taskDetail.stall.note")}
            </label>
            <textarea
              id={noteId}
              rows={2}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              className={`${inputClass} resize-y`}
            />
          </div>
          <div className="flex justify-end gap-1.5">
            <button type="button" className={smallSecondary} onClick={() => setForm(null)}>
              {t("taskDetail.cancel")}
            </button>
            <button type="submit" className={smallPrimary} disabled={!form.reason.trim()}>
              {t("taskDetail.stall.mark")}
            </button>
          </div>
        </form>
      </Section>
    );
  }

  if (!stall) {
    return (
      <Section
        title={t("taskUi.stall.label")}
        empty={t("taskDetail.stall.notStalled")}
        action={
          <button
            type="button"
            className={ghostButton}
            onClick={() => setForm({ reason: "", note: "" })}
          >
            {t("taskDetail.stall.mark")}
          </button>
        }
      />
    );
  }

  const by = manual ? people?.find((p) => p.id === manual.byId)?.name : undefined;
  return (
    <Section
      title={t("taskUi.stall.label")}
      action={
        canEdit &&
        (manual ? (
          <button
            type="button"
            className={ghostButton}
            onClick={() => change(task, { manualStall: null })}
          >
            {t("taskDetail.stall.unmark")}
          </button>
        ) : (
          <button
            type="button"
            className={ghostButton}
            onClick={() => setForm({ reason: "", note: "" })}
          >
            {t("taskDetail.stall.mark")}
          </button>
        ))
      }
    >
      <div data-stall-section className="flex flex-col gap-1">
        <StallMark stall={stall} variant="full" />
        {manual?.note && <p className="pl-5 text-sm text-ink-muted">{manual.note}</p>}
        {by && (
          <p className="pl-5 text-xs text-ink-faint">{t("taskDetail.stall.markedBy", { name: by })}</p>
        )}
      </div>
    </Section>
  );
}
