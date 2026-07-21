import { useEffect, useRef, useState } from "react";

/** Ritardo di default del debounce della ricerca (ms). */
const DEFAULT_DEBOUNCE_MS = 300;

const labelClass = "font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase";

interface DebouncedSearchFieldProps {
  id: string;
  label: string;
  placeholder: string;
  /** Valore corrente della query (dall'URL): risincronizza il draft se cambia. */
  value: string | undefined;
  /**
   * Emesso a debounce scaduto col valore trimmato (o `undefined` se vuoto), così
   * il chiamante può rimuovere il parametro dall'URL. Non emesso a ogni tasto.
   */
  onChange: (value: string | undefined) => void;
  debounceMs?: number;
}

/**
 * Campo di ricerca con debounce, condiviso tra la barra filtri dei ticket e
 * quella del backlog. Lo stato "vero" vive nell'URL del chiamante: qui vive solo
 * il `draft` locale digitato, propagato via {@link onChange} a debounce scaduto
 * per non riscrivere l'URL a ogni tasto. Se `value` cambia da fuori (back/
 * forward, link condiviso) il draft si riallinea.
 */
export function DebouncedSearchField({
  id,
  label,
  placeholder,
  value,
  onChange,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: DebouncedSearchFieldProps) {
  const [draft, setDraft] = useState(value ?? "");
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // Se q cambia da fuori (back/forward, link condiviso) il campo si allinea.
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function handleSearch(next: string) {
    setDraft(next);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onChange(next.trim() || undefined);
    }, debounceMs);
  }

  return (
    <div className="flex min-w-56 flex-1 flex-col gap-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input
        id={id}
        type="search"
        value={draft}
        onChange={(event) => handleSearch(event.target.value)}
        placeholder={placeholder}
        className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
      />
    </div>
  );
}
