import { useId, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Logo } from "../../layout/Rail";
import { inputClass } from "../../tasks-ui/Dialog";

// I pezzi comuni delle schermate d'ingresso (shape `entry.md`): la colonna
// da 400 px a un terzo dall'alto, senza card [IN 1]; il campo con
// l'etichetta sopra; la riga d'errore col glifo; i campi del codice; il
// blocco del secondo fattore. Li usa anche il dialogo di riconferma.

/**
 * La pagina d'ingresso: fuori dall'intelaiatura (niente binario né colonna),
 * la cima trascinabile come la barra del titolo, la colonna da 400 px a un
 * terzo dall'alto (a 64 px dall'alto sotto i 760 px d'altezza, così il modulo
 * e il riquadro del prototipo stanno senza scorrere).
 */
export function EntryColumn({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-ground text-ink">
      <div data-drag-region aria-hidden="true" className="h-9 shrink-0 [-webkit-app-region:drag]" />
      <main className="mx-auto flex w-full max-w-[432px] flex-col px-4 pt-[max(28px,calc(33vh-196px))] pb-12 [@media(max-height:760px)]:pt-7">
        <div className="mb-6">
          <Logo />
        </div>
        {children}
      </main>
    </div>
  );
}

/** Titolo (28 px) e riga in prosa dell'ingresso. */
export function EntryHeading({ title, lead }: { title: string; lead?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-[-0.01em] text-balance text-ink">{title}</h1>
      {lead && <p className="text-md text-pretty text-ink-muted">{lead}</p>}
    </header>
  );
}

/** Un campo dell'ingresso: etichetta sopra (14 px), il campo da 36 px, l'errore sotto. */
export function EntryField({
  label,
  error,
  hint,
  inputRef,
  className = "",
  ...input
}: {
  label: string;
  error?: string | null;
  hint?: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "className">) {
  const id = useId();
  const errorId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`${inputClass} h-9 read-only:bg-ink/4 read-only:text-ink-muted disabled:opacity-50 ${className}`}
        {...input}
      />
      {hint && !error && <span className="text-xs text-ink-muted">{hint}</span>}
      {error && <ErrorLine id={errorId}>{error}</ErrorLine>}
    </div>
  );
}

/**
 * L'etichetta di un bottone con un'attesa («Sign in» → «Signing in…»): le
 * due stanno nella stessa cella, così il bottone resta largo uguale.
 */
export function BusyLabel({
  busy,
  idle,
  pending,
}: {
  busy: boolean;
  idle: ReactNode;
  pending: ReactNode;
}) {
  return (
    <span className="inline-grid justify-items-center">
      <span className={`col-start-1 row-start-1 ${busy ? "invisible" : ""}`}>{idle}</span>
      <span aria-hidden={!busy} className={`col-start-1 row-start-1 ${busy ? "" : "invisible"}`}>
        {pending}
      </span>
    </span>
  );
}

/** Il glifo dell'errore (un cerchio con la croce): il colore non è mai il solo segnale. */
function ErrorGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="mt-[3px] shrink-0 text-critical"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="m5.75 5.75 4.5 4.5M10.25 5.75l-4.5 4.5" />
    </svg>
  );
}

/** Una riga d'errore in parole; `alert` la annuncia quando compare. */
export function ErrorLine({
  children,
  id,
  action,
}: {
  children: ReactNode;
  id?: string;
  action?: ReactNode;
}) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-sm text-ink">
      <ErrorGlyph />
      <span className="min-w-0">{children}</span>
      {action}
    </p>
  );
}

/** Il campo del codice a 6 cifre: cifre tabellari, tastierino numerico, codice monouso. */
export function TotpInput({
  label,
  value,
  onChange,
  disabled,
  inputRef,
  error,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  error?: string | null;
  autoFocus?: boolean;
}) {
  return (
    <EntryField
      label={label}
      inputRef={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      disabled={disabled}
      error={error}
      autoFocus={autoFocus}
      data-autofocus
      className="num text-lg tracking-[0.2em]"
    />
  );
}

/** Il campo del codice di backup, «xxxxx-xxxxx»: è un codice, quindi monospace. */
export function BackupCodeInput({
  label,
  value,
  onChange,
  disabled,
  inputRef,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  error?: string | null;
}) {
  return (
    <EntryField
      label={label}
      inputRef={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value.slice(0, 11))}
      autoComplete="off"
      spellCheck={false}
      placeholder="xxxxx-xxxxx"
      maxLength={11}
      disabled={disabled}
      error={error}
      data-autofocus
      className="font-code text-[14px]!"
    />
  );
}

export type SecondFactorMethod = "totp" | "passkey" | "backup_code";

/**
 * I link degli altri modi («Use a passkey» · «Use a backup code»): quello in
 * uso diventa «Use the authenticator app». `available` toglie un modo che chi
 * si riconferma non ha (al login non si sa: ci sono tutti).
 */
export function OtherMethods({
  method,
  onChange,
  disabled,
  available = { passkey: true, backup_code: true },
}: {
  method: SecondFactorMethod;
  onChange: (method: SecondFactorMethod) => void;
  disabled?: boolean;
  available?: { passkey: boolean; backup_code: boolean };
}) {
  const { t } = useTranslation();
  const others = (["totp", "passkey", "backup_code"] as const).filter(
    (m) => m !== method && (m === "totp" || available[m]),
  );
  if (others.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
      {others.map((m, i) => (
        <span key={m} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden="true">·</span>}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(m)}
            className={`${textButton} disabled:pointer-events-none disabled:opacity-40`}
          >
            {t(`entry.secondFactor.use.${m}`)}
          </button>
        </span>
      ))}
    </p>
  );
}

/** Un link fatto bottone: inchiostro, sottolineato al passaggio. */
export const textButton =
  "rounded-sm text-ink underline-offset-4 transition-colors duration-[var(--duration-fast)] ease-out hover:underline";

/** L'ora di fine di un blocco, «10:42», nell'orologio del prototipo (UTC). */
export function lockTime(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(iso));
}

/**
 * Il blocco del secondo fattore: l'unico filetto `critical` della
 * schermata, con l'orario di fine. Nessun modo di aggirarlo da qui.
 */
export function LockedBlock({ until, children }: { until: string; children?: ReactNode }) {
  const { t, i18n } = useTranslation();
  return (
    <div
      data-second-factor-locked
      role="alert"
      className="flex flex-col gap-2 border-l-2 border-critical py-1 pl-3"
    >
      <p className="text-md text-ink">
        {t("entry.secondFactor.locked", { time: lockTime(until, i18n.language) })}
      </p>
      {children}
    </div>
  );
}

/** Il messaggio di un codice sbagliato: il contatore compare dal secondo errore [IN 4]. */
export function wrongCodeMessage(
  t: (key: string, opts?: Record<string, unknown>) => string,
  triesLeft: number,
  maxTries = 5,
): string {
  return triesLeft >= maxTries - 1
    ? t("entry.secondFactor.wrong")
    : t("entry.secondFactor.wrongTries", { count: triesLeft });
}
