import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { useDeleteAutomationDraft, useRenameAutomation } from "../../../data/queries";
import type { AutomationFlow } from "../../../data/types";
import { Dialog, DialogField, inputClass } from "../../../tasks-ui/Dialog";
import { useToast } from "../../../tasks-ui/Toast";
import { dangerSolidButton, primaryButton, secondaryButton } from "../../tasks/controls";
import { useBuilder } from "./context";

// I dialoghi della testata del costruttore: nome e descrizione, buttare la
// bozza (con Undo), eliminare una bozza mai accesa, uscire con un
// salvataggio fallito.

/** Nome e descrizione: una scrittura a sé, che non tocca la bozza (né ne crea una). */
export function RenameDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const b = useBuilderAutomation();
  const save = useRenameAutomation();
  const [name, setName] = useState(b.name);
  const [description, setDescription] = useState(b.description);
  const submit = () =>
    save.mutate(
      { id: b.id, meta: { name, description } },
      { onSuccess: onClose, onError: () => toast.error(t("automations.builder.renameError")) },
    );
  return (
    <Dialog
      title={t("automations.builder.menu.rename")}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={!name.trim() || save.isPending}
            onClick={submit}
          >
            {t("automations.builder.save.button")}
          </button>
        </>
      }
    >
      <DialogField label={t("automations.create.name")} htmlFor="builder-rename-name">
        <input
          id="builder-rename-name"
          data-autofocus
          className={inputClass}
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </DialogField>
      <DialogField
        label={t("automations.builder.description")}
        htmlFor="builder-rename-description"
      >
        <textarea
          id="builder-rename-description"
          rows={4}
          className={inputClass}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </DialogField>
    </Dialog>
  );
}

/** I dialoghi vivono dentro il provider del costruttore. */
const useBuilderAutomation = () => useBuilder().automation;

export function DiscardDialog({
  flow,
  onClose,
  onDone,
  onRestore,
}: {
  flow: AutomationFlow;
  onClose: () => void;
  onDone: () => void;
  /** «Undo»: rimette la bozza buttata e ricarica il costruttore. */
  onRestore: (flow: AutomationFlow) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const a = useBuilderAutomation();
  const discard = useDeleteAutomationDraft();
  const live = [...a.versions].reverse().find((v) => v.publishedAt !== null);
  return (
    <Dialog
      title={t("automations.builder.discard.title")}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            data-autofocus
            className={dangerSolidButton}
            disabled={discard.isPending}
            onClick={() =>
              discard.mutate(a.id, {
                onSuccess: () => {
                  onDone();
                  toast.show(t("automations.builder.discard.done"), {
                    action: {
                      label: t("automations.builder.undo"),
                      run: () => onRestore(flow),
                    },
                  });
                },
                onError: () => toast.error(t("automations.builder.discard.error")),
              })
            }
          >
            {t("automations.builder.menu.discard")}
          </button>
        </>
      }
    >
      <p className="text-md text-ink">
        {t("automations.builder.discard.body", { m: live?.n ?? 1 })}
      </p>
    </Dialog>
  );
}

export function DeleteDraftDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const a = useBuilderAutomation();
  const del = useDeleteAutomationDraft();
  return (
    <Dialog
      title={t("automations.dialogs.deleteTitle", { code: a.code })}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={dangerSolidButton}
            disabled={del.isPending}
            onClick={() =>
              del.mutate(a.id, {
                onSuccess: () => {
                  onClose();
                  toast.show(t("automations.toast.deleted", { code: a.code }));
                  void navigate({ to: "/automations" });
                },
                onError: () => toast.error(t("automations.toast.deleteError", { code: a.code })),
              })
            }
          >
            {t("automations.actions.delete")}
          </button>
        </>
      }
    >
      <p className="text-md text-ink">{t("automations.dialogs.deleteBody")}</p>
    </Dialog>
  );
}

/** Uscire con un salvataggio fallito chiede conferma. */
export function LeaveDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t("automations.builder.leave.title")}
      width={440}
      onClose={onStay}
      footer={
        <>
          <button type="button" data-autofocus className={secondaryButton} onClick={onStay}>
            {t("automations.builder.leave.stay")}
          </button>
          <button type="button" className={dangerSolidButton} onClick={onLeave}>
            {t("automations.builder.leave.go")}
          </button>
        </>
      }
    >
      <p className="text-md text-ink">{t("automations.builder.leave.body")}</p>
    </Dialog>
  );
}
