import { useState } from "react";
import { useTranslation } from "react-i18next";

/** Nome del file scaricato: uguale in ogni lingua, così si ritrova. */
const RECOVERY_KIT_FILE_NAME = "stubwise-recovery-kit.txt";

interface RecoveryKitPanelProps {
  /** Il testo del kit (la chiave PRIVATA di recupero): vive solo qui, mai sul server. */
  kitText: string;
  /** Etichetta del bottone di prosecuzione, abilitato solo dopo «Ho stampato/salvato il kit». */
  continueLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  /** Etichetta della casella «ho stampato/salvato» (default: quella dell'attivazione). */
  savedLabel?: string;
}

/**
 * Il kit di recupero appena generato, mostrato UNA volta (design «Kit di
 * recupero»): il testo, «Stampa» e «Scarica» (un `.txt` generato nel
 * browser), l'avvertenza «chi ha il kit e il database legge tutto» e la
 * casella che abilita la prosecuzione. Chi lo monta ne tiene il testo solo
 * nel proprio stato e lo butta dopo la conferma.
 */
export function RecoveryKitPanel({
  kitText,
  continueLabel,
  pending = false,
  onConfirm,
  savedLabel,
}: RecoveryKitPanelProps) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);

  function download() {
    const text = `${t("vault:kit.fileHeader")}\n\n${kitText}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = RECOVERY_KIT_FILE_NAME;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-muted">{t("vault:kit.intro")}</p>
      <pre
        data-testid="recovery-kit-text"
        className="rounded-sm border border-line bg-ink-950/70 px-4 py-3 font-mono text-[14px] break-all whitespace-pre-wrap text-fg"
      >
        {kitText}
      </pre>
      <p role="note" className="rounded-sm border border-danger/40 bg-danger/10 p-3 text-sm text-fg">
        {t("vault:kit.warning")}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[12px] tracking-[0.08em] text-fg uppercase transition-colors hover:border-signal-dim"
        >
          {t("vault:kit.print")}
        </button>
        <button
          type="button"
          onClick={download}
          className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[12px] tracking-[0.08em] text-fg uppercase transition-colors hover:border-signal-dim"
        >
          {t("vault:kit.download")}
        </button>
      </div>
      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          className="accent-signal"
        />
        {savedLabel ?? t("vault:kit.saved")}
      </label>
      <button
        type="button"
        disabled={!saved || pending}
        onClick={onConfirm}
        className="rounded-sm bg-signal px-3 py-2.5 font-mono text-[13px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim"
      >
        {continueLabel}
      </button>
    </div>
  );
}
