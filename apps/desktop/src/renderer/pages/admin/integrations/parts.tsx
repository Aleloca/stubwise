import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import type { TestOutcome } from "../../../data/queries";
import { formatDate } from "../../../notifications/time";
import { inputClass } from "../../../tasks-ui/Dialog";
import { ErrorLine } from "../../entry/parts";
import { ChevronGlyph, OpenCircleGlyph, TriangleGlyph } from "../../preferences/glyphs";

// I pezzi comuni delle voci d'integrazione dell'Amministrazione (shape
// admin-integrations.md, «Regole comuni»): la testata, la riga di sola
// lettura col suo «Who?», l'esito di una prova in parole, le parole dei
// rifiuti, il riquadro d'avviso.

/** Quanto dura «Checking…» almeno: una prova vera non è istantanea. */
export const CHECK_MS = 600;

export const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** La pagina di una voce: h1, la riga in prosa, a destra il bottone di creazione. */
export function IntegrationPage({
  title,
  intro,
  action,
  wide = false,
  children,
}: {
  title: string;
  intro: string;
  action?: ReactNode;
  /** Fino a 1040 px invece di 880 (Outgoing webhooks, due colonne). */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className={wide ? "max-w-[1040px]" : "max-w-[880px]"}>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
            <p className="mt-2 max-w-[62ch] text-md text-pretty text-ink-muted">{intro}</p>
          </div>
          {action && <span className="ml-auto flex shrink-0 items-center gap-2 pt-1">{action}</span>}
        </div>
        {children}
      </div>
    </section>
  );
}

/** Una riga 12–13 px in tono minore col cerchio vuoto: una regola detta una volta. */
export function QuietNote({ children, size = "sm" }: { children: ReactNode; size?: "sm" | "xs" }) {
  return (
    <p
      className={`flex items-start gap-1.5 text-pretty text-ink-muted ${size === "xs" ? "text-xs" : "text-sm"}`}
    >
      <span className="mt-[2px] shrink-0">
        <OpenCircleGlyph size={12} />
      </span>
      <span className="min-w-0 max-w-[72ch]">{children}</span>
    </p>
  );
}

/** La riga di sola lettura, una volta in testa: la frase e «Who?» (`action` del catalogo). */
export function ReadOnlyNote({ text, action }: { text: string; action: string }) {
  return (
    <div data-read-only={action} className="mt-3">
      <QuietNote>
        {text} <WhoCanLink action={action} projectId={null} />
      </QuietNote>
    </div>
  );
}

export function Dot() {
  return (
    <span aria-hidden="true" className="text-ink-faint">
      ·
    </span>
  );
}

export function CrossGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

/**
 * L'esito di una prova in parole (shape «Esito di una prova»): «checked Oct
 * 28 · works», «✕ invalid credentials», «✕ unreachable» (`critical` col
 * glifo), «not checked yet»; durante, «Checking…».
 */
export function CheckWords({
  checking,
  last,
}: {
  checking: boolean;
  last: { at: string; outcome: TestOutcome } | null;
}) {
  const { t, i18n } = useTranslation();
  if (checking) return <span>{t("admin.integrations.check.checking")}</span>;
  if (!last) return <span>{t("admin.integrations.check.notChecked")}</span>;
  if (last.outcome === "ok")
    return (
      <span>
        {t("admin.integrations.check.checked", { date: formatDate(last.at, i18n.language) })}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-critical">
      <CrossGlyph />
      <span>{t(`admin.integrations.check.${last.outcome}`)}</span>
    </span>
  );
}

/**
 * Un rifiuto del livello dati in parole, dove è partita l'azione (shape §5).
 * `invalid`, `conflict` e `in_use` li traduce chi chiama (dipendono dal
 * campo); la riconferma chiusa non dice niente qui: lo dice già il suo
 * dialogo («Nothing was changed.»).
 */
export function useRefusalWords() {
  const { t } = useTranslation();
  return (error: string): string => {
    if (error === "reauth_cancelled") return "";
    if (error === "forbidden") return t("admin.integrations.forbidden");
    return t("admin.integrations.saveFailed");
  };
}

/** Il riquadro d'avviso (filetto forte, ▲ `warning`): le conseguenze dette prima dei campi. */
export function WarningBox({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-rule-strong px-3.5 py-3 text-md text-pretty text-ink">
      <span className="mt-[3px] shrink-0 text-warning">
        <TriangleGlyph size={14} />
      </span>
      <p className="min-w-0">
        {title && <strong className="font-semibold">{title}</strong>} {children}
      </p>
    </div>
  );
}

/** Un campo di testo dei dialoghi: etichetta, la riga d'aiuto, l'errore sotto. */
export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  autoFocus = false,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
  /** Un indirizzo, un ref: si scrivono in cifre di codice. */
  mono?: boolean;
}) {
  const id = useId();
  const described = [error ? `${id}-error` : null, hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        type="text"
        data-autofocus={autoFocus || undefined}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={described || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} ${mono ? "font-mono text-sm" : ""}`}
      />
      {error && <ErrorLine id={`${id}-error`}>{error}</ErrorLine>}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-pretty text-ink-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Una sezione chiusa di default (la guida di Google Cloud, come ottenere
 * l'indirizzo del webhook): un bottone col chevron apre il contenuto sotto.
 */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="rounded-md border border-rule">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
      >
        <ChevronGlyph open={open} />
        {title}
      </button>
      {open && (
        <div id={id} className="flex flex-col gap-3 border-t border-rule px-3 py-3">
          {children}
        </div>
      )}
    </div>
  );
}

/** La casella di fiducia dei plugin: il valore è nello stato del dialogo, mai salvato. */
export function TrustBox({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-default items-start gap-2.5 rounded-md border border-rule px-3 py-2.5 transition-colors duration-[var(--duration-fast)] ease-out hover:border-rule-strong has-[:checked]:border-rule-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--ink)]"
      />
      <span className="text-md font-medium text-ink">{label}</span>
    </label>
  );
}
