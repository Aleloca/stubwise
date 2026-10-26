import { useTranslation } from "react-i18next";
import { useCancelAutomationRun, useSkipAutomationStep } from "../../data/queries";
import type { AutomationRunDetail } from "../../data/types";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { dangerSolidButton, primaryButton, secondaryButton } from "../tasks/controls";
import { stepName } from "./RunNow";

// I dialoghi di un'esecuzione (shape automations.md §«Annulla», «Retry/Skip»):
// annullare dice che ciò che è già nato resta; saltare dice che i passi dopo
// possono fallire senza i suoi dati.

export function CancelRunDialog({
  run,
  onClose,
}: {
  run: AutomationRunDetail;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const cancel = useCancelAutomationRun();
  return (
    <Dialog
      title={t("automations.dialogs.cancelTitle", { code: run.code })}
      width={400}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.keep")}
          </button>
          <button
            type="button"
            className={dangerSolidButton}
            disabled={cancel.isPending}
            onClick={() =>
              cancel.mutate(run.id, {
                onSuccess: () => {
                  onClose();
                  toast.show(t("automations.toast.cancelled", { code: run.code }));
                },
                onError: () =>
                  toast.error(t("automations.toast.decisionError", { code: run.code })),
              })
            }
          >
            {t("automations.actions.cancelRun")}
          </button>
        </>
      }
    >
      <p className="text-md text-ink">{t("automations.dialogs.cancelBody")}</p>
    </Dialog>
  );
}

export function SkipStepDialog({
  run,
  onClose,
}: {
  run: AutomationRunDetail;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const skip = useSkipAutomationStep();
  return (
    <Dialog
      title={t("automations.dialogs.skipTitle", { number: stepName(run, t)?.number ?? "" })}
      width={400}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={skip.isPending}
            onClick={() =>
              skip.mutate(run.id, {
                onSuccess: () => {
                  onClose();
                  toast.show(t("automations.toast.skipped", { code: run.code }));
                },
                onError: () =>
                  toast.error(t("automations.toast.decisionError", { code: run.code })),
              })
            }
          >
            {t("automations.actions.skip")}
          </button>
        </>
      }
    >
      <p className="text-md text-ink">{t("automations.dialogs.skipBody")}</p>
    </Dialog>
  );
}
