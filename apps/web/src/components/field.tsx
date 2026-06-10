import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
}

/** Campo testuale con label mono in maiuscoletto, stile "pannello strumenti". */
export function TextField({ id, label, ...inputProps }: TextFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
      >
        {label}
      </label>
      <input
        id={id}
        className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-[15px] text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        {...inputProps}
      />
    </div>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  id: string;
  label: string;
  options: { value: string; label: string }[];
}

/** Select con label mono in maiuscoletto, gemello di {@link TextField}. */
export function SelectField({ id, label, options, ...selectProps }: SelectFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
      >
        {label}
      </label>
      <select
        id={id}
        className="rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1.5 font-mono text-[13px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        {...selectProps}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Box errore dei form: renderizzato solo quando c'è un messaggio. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-[13px] text-danger"
    >
      {message}
    </p>
  );
}

/** Bottone primario dei form auth: blocco ambra pieno, testo inchiostro. */
export function SubmitButton({ children, pending }: { children: string; pending: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-1 rounded-sm bg-signal px-3 py-2.5 font-mono text-[13px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim"
    >
      {children}
    </button>
  );
}
