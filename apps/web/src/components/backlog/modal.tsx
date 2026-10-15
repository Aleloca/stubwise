import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/*
 * Guscio modale e dialog di conferma della pagina di una voce di backlog,
 * estratti senza modifiche da `routes/backlog/$id.tsx` perché li usa anche
 * «Chiudi sessione» della vista di una sessione di refinement (piano B, B2).
 */

export const actionButtonClass =
  "rounded-sm border border-line-strong px-3 py-2 font-mono text-[12px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

export const actionPrimaryClass =
  "rounded-sm bg-signal px-3 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60";

/** Dialog di conferma generica (usata dalla conversione in task). */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ModalShell titleId="confirm-title" onClose={onClose}>
      <h2 id="confirm-title" className="text-lg font-semibold">
        {title}
      </h2>
      <p className="mt-1 text-sm text-fg-muted">{body}</p>
      <div className="mt-4 flex items-center justify-end gap-3">
        <button type="button" onClick={onClose} className={actionButtonClass}>
          {t("backlog:actions.cancel")}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className={actionPrimaryClass}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

/** Guscio modale riusabile: overlay + Escape + click fuori per chiudere. */
export function ModalShell({
  titleId,
  onClose,
  children,
}: {
  titleId: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Focus programmatico sul pannello all'apertura (pattern Drawer): l'handler
  // Escape vive sull'overlay via onKeyDown, quindi senza spostare il focus dal
  // bottone che ha aperto la dialog Escape resterebbe inerte.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink-950/80 p-3 backdrop-blur-[2px] sm:p-6"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md border border-line bg-ink-900 p-5 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
      >
        {children}
      </div>
    </div>
  );
}
