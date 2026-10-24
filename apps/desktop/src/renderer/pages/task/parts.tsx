import { useId, type ReactNode } from "react";

// I pezzi comuni delle sezioni del pannello della task: intestazione di
// gruppo, bottoni leggeri, conferma in linea.

/** Azione leggera dentro una sezione («Add», «Edit», «Reply»): testo, tinta al passaggio. */
export const ghostButton =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:bg-ink/10";

/** Azione distruttiva confermata: il rosso è nel testo e nel contorno, la parola dice cosa fa. */
export const dangerButton =
  "inline-flex h-7 shrink-0 items-center rounded-md border border-critical/50 px-2.5 text-sm font-semibold text-critical transition-colors duration-[var(--duration-fast)] ease-out hover:bg-critical/10";

/** Bottone piccolo d'inchiostro pieno (il primario dentro una sezione). */
export const smallPrimary =
  "inline-flex h-7 shrink-0 items-center rounded-md bg-ink px-2.5 text-sm font-semibold text-ground transition-opacity duration-[var(--duration-fast)] ease-out hover:opacity-90 active:opacity-80 disabled:opacity-40";

/** Bottone piccolo col contorno. */
export const smallSecondary =
  "inline-flex h-7 shrink-0 items-center rounded-md border border-rule-strong px-2.5 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6";

/**
 * Una sezione del pannello: filetto sopra, intestazione di gruppo (l'unico
 * posto dove si usa il maiuscoletto spaziato) con il conteggio e l'azione a
 * destra. Una sezione vuota passa `empty`: resta una riga sola.
 */
export function Section({
  title,
  count,
  action,
  empty,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  empty?: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t border-rule px-4 py-3">
      <div className="flex min-h-7 items-center gap-2">
        <h3 id={id} className="heading-group shrink-0">
          {title}
        </h3>
        {count !== undefined && count > 0 && (
          <span className="num text-xs text-ink-faint">{count}</span>
        )}
        {empty && <span className="min-w-0 flex-1 text-sm text-ink-faint">{empty}</span>}
        {action && <span className="ml-auto flex items-center gap-1">{action}</span>}
      </div>
      {children}
    </section>
  );
}

/** «Delete this comment? …» con le due scelte, al posto delle azioni. */
export function InlineConfirm({
  message,
  confirm,
  onConfirm,
  onCancel,
  cancelLabel,
}: {
  message: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  cancelLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={message}
      className="flex flex-wrap items-center gap-2 rounded-md bg-ink/4 px-2.5 py-2"
    >
      <p className="min-w-0 flex-1 basis-48 text-sm text-ink">{message}</p>
      <div className="flex items-center gap-1.5">
        <button type="button" className={smallSecondary} onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className={dangerButton} onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </div>
  );
}

export function CloseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

/** «Altre azioni»: tre punti, per i menu in riga. */
export function MoreIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}
