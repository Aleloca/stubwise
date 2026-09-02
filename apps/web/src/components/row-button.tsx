/**
 * Bottone d'azione di una riga di lista nelle superfici di amministrazione
 * (provider AI, registro plugin, plugin del progetto): bordo sottile, testo
 * mono maiuscolo, variante `danger` per le azioni distruttive.
 *
 * Estratto perché è al terzo utilizzo: era duplicato identico in due sezioni e
 * la terza avrebbe reso la divergenza inevitabile — un bottone d'azione che in
 * una lista sembra un altro peso è un difetto visibile.
 */
export function RowButton({
  onClick,
  label,
  disabled,
  danger,
  type = "button",
}: {
  onClick?: () => void;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-sm border bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? "border-danger/30 text-danger hover:border-danger/60"
          : "border-line-strong text-fg-muted hover:border-ink-700 hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}
