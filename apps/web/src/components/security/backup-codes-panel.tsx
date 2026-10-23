import { useState } from "react";
import { useTranslation } from "react-i18next";

/** Nome del file scaricato: uguale in ogni lingua, così si ritrova. */
const BACKUP_CODES_FILE_NAME = "stubwise-backup-codes.txt";

interface BackupCodesPanelProps {
  /** I codici in chiaro: esistono solo in questa risposta, mai più dopo. */
  codes: string[];
  /** «Continua», abilitato solo dopo «Ho salvato i codici». */
  onConfirm: () => void;
}

/**
 * I codici di riserva appena generati, mostrati UNA volta: elenco, «Scarica»
 * (un `.txt`, generato nel browser) e la casella «Ho salvato i codici» che
 * abilita «Continua». Serve al login, alla rigenerazione in Impostazioni e
 * alla prima configurazione da riconferma.
 */
export function BackupCodesPanel({ codes, onConfirm }: BackupCodesPanelProps) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);

  function download() {
    const text = `${t("auth:backupCodes.fileHeader")}\n\n${codes.join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = BACKUP_CODES_FILE_NAME;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-muted">{t("auth:backupCodes.intro")}</p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-sm border border-line bg-ink-950/70 px-4 py-3 font-mono text-[14px] text-fg">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={download}
        className="self-start rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[12px] tracking-[0.08em] text-fg uppercase transition-colors hover:border-signal-dim"
      >
        {t("auth:backupCodes.download")}
      </button>
      <label className="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          className="accent-signal"
        />
        {t("auth:backupCodes.saved")}
      </label>
      <button
        type="button"
        disabled={!saved}
        onClick={onConfirm}
        className="rounded-sm bg-signal px-3 py-2.5 font-mono text-[13px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim"
      >
        {t("auth:backupCodes.continue")}
      </button>
    </div>
  );
}
