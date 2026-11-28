import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "../../tasks-ui/Dialog";
import { itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { dangerSolidButton, MenuButton, quietButton } from "../tasks/controls";
import { ghostButton, MoreIcon } from "./parts";

/**
 * Il «⋯» dell'intestazione di DESIGN o di PLAN, con «Remove design…» o
 * «Remove plan…» (shape `design-plan-remove.md`, DP-Q1): un dialogo con la
 * conseguenza in una riga, poi Remove e Cancel; dopo, il toast. Lo mostra
 * solo chi può togliere (la pagina lo decide dai permessi del livello dati).
 */
export function RemoveDesignPlanMenu({
  which,
  consequence,
  onRemove,
}: {
  which: "design" | "plan";
  /** La riga della conseguenza, diversa fra richiesta e task. */
  consequence: string;
  /** La scrittura; vero se è riuscita. */
  onRemove: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = t(`designPlan.${which}.more`);
  const confirm = async () => {
    setBusy(true);
    const ok = await onRemove().catch(() => false);
    setBusy(false);
    if (!ok) return void toast.error(t(`designPlan.${which}.failed`));
    setConfirming(false);
    toast.show(t(`designPlan.${which}.removed`));
  };
  return (
    <>
      <MenuButton
        menuLabel={label}
        ariaLabel={label}
        title={label}
        align="right"
        className={`${ghostButton} h-6 w-6 justify-center px-0 aria-expanded:bg-ink/8`}
        label={<MoreIcon />}
      >
        {(close) => (
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              close();
              setConfirming(true);
            }}
          >
            {t(`designPlan.${which}.remove`)}
          </button>
        )}
      </MenuButton>
      {confirming && (
        <Dialog
          title={t(`designPlan.${which}.dialogTitle`)}
          onClose={() => setConfirming(false)}
          width={440}
          footer={
            <>
              <button type="button" className={quietButton} onClick={() => setConfirming(false)}>
                {t("designPlan.cancel")}
              </button>
              <button
                type="button"
                className={dangerSolidButton}
                aria-busy={busy || undefined}
                disabled={busy}
                onClick={() => void confirm()}
              >
                {t("designPlan.confirm")}
              </button>
            </>
          }
        >
          <p className="text-md text-ink">{consequence}</p>
        </Dialog>
      )}
    </>
  );
}
