import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Menu, itemClass } from "../../tasks-ui/Menu";
import { ErrorLine, textButton } from "../entry/parts";
import { now } from "../../data/dates";
import { formatDate } from "../../notifications/time";
import { relativeDay, whenWithTime } from "../mail/format";
import { MoreGlyph } from "./glyphs";

// I pezzi comuni delle Preferenze personali (shape preferences-account.md,
// [PR 1]): la cornice di Notifiche (h1 28 px, una riga in prosa, parti
// separate da filetti con titolo 20 px, nessuna card), le righe con le
// azioni a destra, la conferma a due tempi in posto, il menu «⋯» di riga,
// l'apertura in posto che spinge giù il resto.

/** La pagina di una sezione: titolo, riga in prosa, poi le parti (fino a 720 px). */
export function PrefsPage({
  title,
  intro,
  action,
  children,
}: {
  title: string;
  intro: string;
  /** L'azione della pagina, a destra del titolo («New token»). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className="max-w-[720px]">
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-[-0.01em] text-ink">
            {title}
          </h1>
          {action}
        </div>
        <p className="mt-2 max-w-[62ch] text-md text-pretty text-ink-muted">{intro}</p>
        {children}
      </div>
    </section>
  );
}

/** Una parte della pagina: filetto sopra, titolo 20 px, l'azione della parte a destra. */
export function Part({
  title,
  action,
  children,
  partRef,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  partRef?: React.Ref<HTMLElement>;
}) {
  const id = useId();
  return (
    <section
      ref={partRef}
      aria-labelledby={id}
      className="mt-8 scroll-mt-6 border-t border-rule pt-5 first-of-type:mt-6"
    >
      <div className="flex min-h-8 items-center gap-3">
        <h2 id={id} className="min-w-0 flex-1 text-xl font-semibold text-ink">
          {title}
        </h2>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** Una riga di elenco: 44 px, filetto sotto (non sull'ultima), le azioni a destra. */
export const rowClass =
  "flex min-h-11 items-center gap-3 border-b border-rule py-1.5 last:border-b-0";

/** Bottone di riga, testo quieto: «Rename», «Sign out», «Reconnect». */
export const rowButton =
  "inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:bg-ink/10 disabled:pointer-events-none disabled:opacity-40";

/** Quanto resta armata una conferma a due tempi. */
const ARMED_MS = 4000;

/**
 * La conferma a due tempi in posto: il primo clic arma il bottone
 * («Revoke — sure?», in `critical`), il secondo esegue. Si disarma da sola
 * dopo 4 secondi, con Esc o perdendo il fuoco.
 */
export function ArmedButton({
  label,
  sureLabel,
  onConfirm,
  ariaLabel,
  className = rowButton,
  disabled,
  autoArm = false,
  onDisarm,
}: {
  label: string;
  sureLabel: string;
  onConfirm: () => void;
  /** Il nome per chi non vede la riga («Revoke my-laptop MCP»), solo da disarmato. */
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  /** Già armato all'apertura (dopo una voce «Remove…» del menu di riga). */
  autoArm?: boolean;
  onDisarm?: () => void;
}) {
  const [armed, setArmed] = useState(autoArm);
  const ref = useRef<HTMLButtonElement>(null);
  const disarm = () => {
    setArmed(false);
    onDisarm?.();
  };
  useEffect(() => {
    if (autoArm) ref.current?.focus();
  }, [autoArm]);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(disarm, ARMED_MS);
    return () => window.clearTimeout(timer);
    // `disarm` cambia a ogni render: il timer dipende solo dall'armo.
  }, [armed]);
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      aria-label={armed ? undefined : ariaLabel}
      onKeyDown={(e) => {
        if (armed && e.key === "Escape") {
          e.preventDefault();
          disarm();
        }
      }}
      onBlur={() => armed && disarm()}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
      className={`${className} ${armed ? "text-critical!" : ""}`}
    >
      {armed ? sureLabel : label}
    </button>
  );
}

/** Il menu «⋯» di una riga, con le voci passate come figli (`role="menuitem"`). */
export function RowMenu({
  label,
  children,
}: {
  label: string;
  children: (close: (restore: boolean) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) button.current?.focus();
  };
  return (
    <span className="relative shrink-0">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="grid size-7 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink"
      >
        <MoreGlyph />
      </button>
      {open && (
        <Menu label={label} onClose={close} align="right">
          {children(close)}
        </Menu>
      )}
    </span>
  );
}

/** Una voce del menu di riga. */
export function RowMenuItem({ children, onSelect }: { children: ReactNode; onSelect: () => void }) {
  return (
    <button type="button" role="menuitem" className={itemClass} onClick={onSelect}>
      {children}
    </button>
  );
}

/** L'apertura in posto (nuovo token, aggiungi passkey, l'app): 200 ms in altezza, spinge giù il resto. */
export function Reveal({ children }: { children: ReactNode }) {
  return (
    <div className="alert-group-enter grid">
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** L'errore di scrittura sotto il controllo che l'ha fatta: ✕ + frase + «Retry». */
export function WriteError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <ErrorLine
      action={
        onRetry && (
          <button type="button" className={`${textButton} ml-1`} onClick={onRetry}>
            {t("prefs.common.retry")}
          </button>
        )
      }
    >
      {message}
    </ErrorLine>
  );
}

/** L'errore di lettura al posto delle parti (la colonna e il titolo restano). */
export function ReadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-6 border-t border-rule pt-5">
      <WriteError message={message} onRetry={onRetry} />
    </div>
  );
}

/** Lo scheletro delle righe di una parte (3 righe). */
export function RowsSkeleton({ parts = 2 }: { parts?: number }) {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {Array.from({ length: parts }, (_, p) => (
        <div key={p} className="mt-8 border-t border-rule pt-5 first:mt-6">
          <span className={`block h-4 w-36 ${bar}`} />
          {[60, 44, 52].map((w, i) => (
            <div
              key={i}
              className="flex h-11 items-center gap-3 border-b border-rule last:border-b-0"
            >
              <span className={`h-2.5 ${bar}`} style={{ width: `${w}%` }} />
              <span className={`ml-auto h-2.5 w-16 ${bar}`} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** «today», «yesterday» o la data, sull'orologio del prototipo. */
export function useDayWord() {
  const { t, i18n } = useTranslation();
  return (iso: string) =>
    relativeDay(iso, i18n.language, {
      today: t("prefs.common.today"),
      yesterday: t("prefs.common.yesterday"),
    });
}

/**
 * Da quanto, sull'orologio del prototipo: «5 min ago» entro l'ora, «2 h ago»
 * entro il giorno, poi la data con l'ora. Sono le parole di Intl, nella lingua.
 */
export function whenSynced(iso: string, language: string): string {
  const minutes = Math.round((Date.parse(now()) - Date.parse(iso)) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  if (minutes < 60) return rtf.format(-Math.max(0, minutes), "minute");
  if (minutes < 24 * 60) return rtf.format(-Math.floor(minutes / 60), "hour");
  return whenWithTime(iso, language);
}

/** La data breve («Sep 3»), anche per oggi: è un giorno, non un'ora. */
export function useDateLabel() {
  const { i18n } = useTranslation();
  return (iso: string) => formatDate(iso, i18n.language);
}

/** Un messaggio che resta 2 secondi («Saved», «Copied»). */
export function useFlash(ms = 2000): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return [
    on,
    () => {
      setOn(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setOn(false), ms);
    },
  ];
}

/** Un rifiuto del livello dati (`{ ok: false, error }`), da dire in parole dove è partito. */
export function refusalOf(r: unknown): { error: string; reason?: string } | null {
  if (typeof r !== "object" || r === null || (r as { ok?: unknown }).ok !== false) return null;
  return r as { error: string; reason?: string };
}
