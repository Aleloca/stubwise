import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useExplainRelease, useFixRelease, useSendMessage } from "../../data/queries";
import type { ReleaseView } from "../../data/releases";
import { can, useViewer } from "../../data/viewer";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { prCode } from "./format";

// «Fai sistemare a Claude» ([R 16]): un dialogo con l'anteprima della task
// che nasce e una nota facoltativa per Claude, invece di crearla con un
// clic. Un rilascio ha al massimo una task di riparazione aperta: un secondo
// clic (anche arrivato da altrove) apre la stessa (lo garantisce `fixRelease`).
// «Chiedi a Claude di spiegarlo» ([R 17]): una conversazione mia col
// rilascio come contesto e la prima domanda già inviata; un secondo clic
// riapre la mia.

export function FixDialog({ release, onClose }: { release: ReleaseView; onClose: () => void }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const fix = useFixRelease();
  const toast = useToast();
  const noteId = useId();
  const [note, setNote] = useState("");
  // Gli stessi dati di `fixRelease`: titolo dal passo fallito, task correlata, log.
  const preview = release.fixPreview;
  // Il gate del piano: chi non ha `plans.approve` lo legge prima di partire.
  const approves = can(viewer, "plans.approve", release.projectId);

  const submit = () =>
    fix.mutate(
      { code: release.code, note },
      {
        onSuccess: (task) => {
          onClose();
          // Una task già aperta (un altro clic, un'altra persona): lo si dice, e
          // si dice che fine ha fatto la nota.
          const key = !task.existing
            ? "releases.fix.created"
            : !note.trim()
              ? "releases.fix.existing"
              : task.noteAdded
                ? "releases.fix.existingNote"
                : "releases.fix.existingNoteUnused";
          toast.show(t(key, { task: task.code }));
        },
        onError: () => toast.error(t("releases.fix.error", { code: release.code })),
      },
    );

  return (
    <Dialog
      title={t("releases.fix.title", { code: release.code })}
      width={480}
      onClose={onClose}
      confirmDiscard={
        note.trim()
          ? {
              message: t("releases.fix.discard"),
              keep: t("releases.fix.keep"),
              discard: t("releases.fix.discardConfirm"),
            }
          : undefined
      }
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("releases.cancel")}
          </button>
          <button
            type="button"
            data-fix-submit
            disabled={fix.isPending}
            onClick={submit}
            className={`${primaryButton} disabled:opacity-40`}
          >
            {release.canStartFix ? t("releases.fix.createAndStart") : t("releases.fix.create")}
          </button>
        </>
      }
    >
      <dl className="flex flex-col gap-2 rounded-lg border border-rule px-4 py-3 text-sm">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-ink-muted">{t("releases.fix.type")}</dt>
          <dd className="text-ink">{t("releases.fix.bug")}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-ink-muted">{t("releases.fix.titleLabel")}</dt>
          <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">
            {preview.step
              ? t("releases.fix.taskTitle", { code: release.code, step: preview.step })
              : t("releases.fix.taskTitleNoStep", { code: release.code, title: release.title })}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-ink-muted">{t("releases.fix.linked")}</dt>
          <dd className="min-w-0 text-ink">
            <span className="num">{prCode(release.pr)}</span>
            {preview.relatedTaskCode && (
              <span className="text-ink-muted">
                {" · "}
                {t("releases.fix.related", { task: preview.relatedTaskCode })}
              </span>
            )}
          </dd>
        </div>
        <p className="text-ink-muted">
          {!preview.step
            ? t("releases.fix.attachedNoStep")
            : preview.logLines
              ? t("releases.fix.attachedLog", { step: preview.step })
              : t("releases.fix.attached", { step: preview.step })}
        </p>
      </dl>
      <DialogField label={t("releases.fix.note")} htmlFor={noteId}>
        <textarea
          id={noteId}
          data-autofocus
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={`${inputClass} resize-y`}
        />
      </DialogField>
      {!release.canStartFix && (
        <p className="text-sm text-ink-muted">
          {t("releases.fix.waits", { code: release.projectCode })}
        </p>
      )}
      {release.canStartFix && !approves && (
        <p className="text-sm text-ink-muted">
          {t("releases.fix.planGate", { code: release.projectCode })}
        </p>
      )}
    </Dialog>
  );
}

/** «Chiedi a Claude di spiegarlo»: apre (o riapre) la mia conversazione sul rilascio. */
export function useExplain() {
  const { t } = useTranslation();
  const explain = useExplainRelease();
  const send = useSendMessage();
  const navigate = useNavigate();
  const toast = useToast();
  return {
    pending: explain.isPending,
    run: async (release: ReleaseView) => {
      try {
        const c = await explain.mutateAsync(release.code);
        if (!c.reused) {
          // La risposta arriva nella conversazione: non si aspetta qui.
          send.mutate({ id: c.id, text: t("releases.explain.question", { code: release.code }) });
        }
        void navigate({ to: "/claude/$id", params: { id: c.id } });
      } catch {
        toast.error(t("releases.explain.error", { code: release.code }));
      }
    },
  };
}
