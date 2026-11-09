import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { inputClass } from "../../tasks-ui/Dialog";
import { SearchGlyph } from "./glyphs";

// I pezzi comuni dei selettori Google (cartelle, file, progetti): il campo
// di ricerca con la lente, l'elenco `listbox` con le frecce (↑/↓ muovono il
// fuoco fra le opzioni, Home/End agli estremi), le righe da 36 px e gli
// stati — 6 righe scheletro, vuoto, nessun risultato, errore con «Retry».

/** Una riga del selettore: 36 px, tinta al passaggio, scelta in tinta più forte. */
export const optionClass =
  "flex h-9 w-full min-w-0 shrink-0 cursor-default items-center gap-2.5 rounded-md px-2 text-left text-md text-ink outline-none transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus aria-selected:bg-ink/10 aria-disabled:text-ink-faint aria-disabled:hover:bg-transparent";

export function PickerSearch({
  label,
  value,
  onChange,
  onKeyDown,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="relative flex min-w-0 items-center">
      <span className="pointer-events-none absolute left-2.5 text-ink-faint">
        <SearchGlyph />
      </span>
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        data-autofocus
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className={`${inputClass} pl-8`}
      />
    </label>
  );
}

/**
 * Le frecce dentro un elenco di opzioni: muovono il fuoco fra le righe
 * (comprese le disattivate, che si leggono ma non si scelgono). Dal campo di
 * ricerca ↓ entra nell'elenco.
 */
export function useListKeys() {
  const list = useRef<HTMLDivElement>(null);
  const options = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
  const focusAt = (i: number) => {
    const all = options();
    const el = all[Math.max(0, Math.min(all.length - 1, i))];
    el?.focus();
  };
  const onListKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const all = options();
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(i + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(all.length - 1);
    }
  };
  const enterFromSearch = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    focusAt(0);
  };
  return { list, onListKeyDown, enterFromSearch };
}

/** Le 6 righe scheletro di un selettore che carica. */
export function PickerSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="skeleton-breathe flex flex-col gap-px">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {["52%", "38%", "61%", "45%", "57%", "33%"].map((w, i) => (
        <span key={i} className="flex h-9 items-center gap-2.5 px-2">
          <span className="size-4 rounded-sm bg-ink/8" />
          <span className="h-2.5 rounded-sm bg-ink/8" style={{ width: w }} />
        </span>
      ))}
    </div>
  );
}

/** Una riga quieta al posto dell'elenco: vuoto, nessun risultato, errore (con «Retry»). */
export function PickerNote({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="text-sm text-ink-muted">{children}</p>
      {action}
    </div>
  );
}
