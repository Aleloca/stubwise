import { useState, type ReactNode } from "react";
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
  note,
  labelAria,
  icon,
}: {
  label: string;
  confirmLabel: string;
  confirmAria: string;
  pending: boolean;
  onConfirm: () => void;
  /** Un avviso mostrato SOLO mentre si chiede conferma (es. il registro decisioni). */
  note?: string;
  /**
   * `aria-label` del SOLO primo bottone (es. «Elimina il commento di …»), per
   * distinguere bottoni con lo stesso testo visibile. Assente = invariato.
   */
  labelAria?: string;
  /** Un'icona prima del testo del SOLO primo bottone (le azioni di un commento). Assente = invariato. */
  icon?: ReactNode;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        aria-label={labelAria}
        onClick={() => setConfirming(true)}
        className={icon !== undefined ? `${deleteButtonClass} inline-flex items-center gap-1` : deleteButtonClass}
      >
        {icon}
        {label}
      </button>
    );
  }
  return (
    // `flex-wrap` solo con la nota: gli altri usi restano identici a prima.
    <span className={note !== undefined ? "flex flex-wrap items-center gap-2" : "flex items-center gap-2"}>
      {note !== undefined && (
        <span className="w-full font-mono text-[11px] text-fg-muted">{note}</span>
      )}
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
