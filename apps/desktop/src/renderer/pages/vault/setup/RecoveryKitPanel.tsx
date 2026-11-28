import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { primaryButton, secondaryButton } from "../../tasks/controls";
import { BusyLabel } from "../../entry/parts";

/** Il nome del file scaricato: uguale in ogni lingua, così si ritrova. */
export const RECOVERY_KIT_FILE_NAME = "stubwise-recovery-kit.txt";

/**
 * Il kit di recupero appena generato nel worker, mostrato UNA volta (design
 * §10, come il web vecchio): il testo, «Print» e «Download» (un `.txt` fatto
 * qui), l'avvertenza e la casella che abilita la prosecuzione. Il testo sta
 * solo nello stato di chi monta il pannello, che lo butta dopo la conferma:
 * mai negli appunti, in una cache, in `#print-root` o nel contesto di Claude.
 */
export function RecoveryKitPanel({
  kitText,
  savedLabel,
  continueLabel,
  pendingLabel,
  pending,
  onConfirm,
}: {
  kitText: string;
  savedLabel: string;
  continueLabel: string;
  pendingLabel: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const labelId = useId();

  function download() {
    const text = `${t("vault.setup.kit.fileHeader")}\n\n${kitText}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = RECOVERY_KIT_FILE_NAME;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-md text-ink-muted">{t("vault.setup.kit.intro")}</p>
      <p id={labelId} className="text-sm font-medium text-ink">
        {t("vault.setup.kit.label")}
      </p>
      <pre
        aria-labelledby={labelId}
        data-recovery-kit
        translate="no"
        data-gramm="false"
        className="num rounded-md border border-rule bg-ink/3 px-4 py-3 font-mono text-md break-all whitespace-pre-wrap text-ink"
      >
        {kitText}
      </pre>
      <p role="note" className="rounded-md border border-critical/40 bg-critical/8 p-3 text-sm text-ink">
        {t("vault.setup.kit.warning")}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondaryButton} onClick={() => window.print()}>
          {t("vault.setup.kit.print")}
        </button>
        <button type="button" className={secondaryButton} onClick={download}>
          {t("vault.setup.kit.download")}
        </button>
      </div>
      <label className="flex items-center gap-2 text-md text-ink">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        {savedLabel}
      </label>
      <button
        type="button"
        className={`${primaryButton} self-start disabled:opacity-40`}
        disabled={!saved || pending}
        onClick={onConfirm}
      >
        <BusyLabel busy={pending} idle={continueLabel} pending={pendingLabel} />
      </button>
    </div>
  );
}
