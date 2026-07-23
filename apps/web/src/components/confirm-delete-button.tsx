import { useState } from "react";
import { useTranslation } from "react-i18next";

const deleteButtonClass =
  "rounded-sm border border-danger/30 bg-ink-950/70 px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] text-danger uppercase transition-colors hover:border-danger/60 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Bottone di rimozione a due passi (pattern access-tokens): il primo click
 * rivela "Conferma"/"Annulla"; solo il secondo esegue. Stile terminal, tono
 * danger. Condiviso da backlog e ticket per scollegare design e piano.
 *
 * `confirmLabel` è il testo del bottone di conferma (di norma "Conferma"),
 * `confirmAria` il suo aria-label — che distingue design da piano per gli AT.
 * Il bottone "Annulla" usa la chiave i18n condivisa `common:cancel`.
 */
export function ConfirmDeleteButton({
  label,
  confirmLabel,
  confirmAria,
  pending,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  confirmAria: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className={deleteButtonClass}>
        {label}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        aria-label={confirmAria}
        onClick={onConfirm}
        className={deleteButtonClass}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded-sm border border-line-strong px-2.5 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
      >
        {t("common:cancel")}
      </button>
    </span>
  );
}
