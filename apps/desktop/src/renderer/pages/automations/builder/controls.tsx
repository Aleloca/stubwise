import { useId, type ReactNode } from "react";
import { RadioDot } from "../../../tasks-ui/Menu";

// I controlli del pannello del passo: sezioni con heading-group, campi con
// etichetta e problema sotto (`aria-describedby`), scelte segmentate, radio
// a tutta larghezza con la frase di conseguenza. Gli stessi filetti dei
// campi di dialogo (`inputClass`).

export const smallInput =
  "h-8 min-w-0 rounded-md border border-rule-strong bg-transparent px-2.5 text-md text-ink placeholder:text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:border-ink/40 focus-visible:border-transparent disabled:opacity-60";

export const selectClass = `${smallInput} pr-1.5`;

/** Una sezione del pannello: titolo di gruppo e contenuto. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-t border-rule px-5 py-4">
      <h3 id={id} className="heading-group">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Un campo: etichetta sopra, controllo, nota muted, problema in `critical`. */
export function Field({
  label,
  required = false,
  htmlFor,
  note,
  children,
}: {
  label: string;
  required?: boolean;
  htmlFor?: string;
  note?: string;
  children: ReactNode;
}) {
  const text = (
    <>
      {label}
      {required && (
        <span aria-hidden="true" className="text-ink-faint">
          {" *"}
        </span>
      )}
    </>
  );
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
          {text}
        </label>
      ) : (
        <span className="text-sm font-medium text-ink">{text}</span>
      )}
      {children}
      {note && <p className="text-xs text-ink-muted">{note}</p>}
    </div>
  );
}

/** Una scelta a segmenti («A person · A department · A role in the project»). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex w-fit max-w-full flex-wrap rounded-md border border-rule-strong p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`h-7 rounded-[5px] px-2.5 text-sm transition-colors duration-[var(--duration-fast)] ease-out ${value === o.value ? "bg-ink/10 font-medium text-ink" : "text-ink-muted hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Radio a tutta larghezza con la frase di conseguenza sotto. */
export function RadioRow({
  checked,
  label,
  body,
  onSelect,
  disabled = false,
  children,
}: {
  checked: boolean;
  label: string;
  body: string;
  onSelect: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-md border px-3 py-2.5 ${checked ? "border-rule-strong" : "border-rule"}`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled}
        onClick={onSelect}
        className="flex items-start gap-2.5 text-left"
      >
        <span className="pt-0.5">
          <RadioDot checked={checked} />
        </span>
        <span className="flex flex-col gap-0.5">
          <span className="text-md font-medium text-ink">{label}</span>
          <span className="text-sm text-ink-muted">{body}</span>
        </span>
      </button>
      {checked && children}
    </div>
  );
}

/** Una riga fissa di spiegazione (muted, 13px). */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-muted">{children}</p>;
}
