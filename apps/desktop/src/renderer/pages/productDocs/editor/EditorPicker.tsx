import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { inputClass } from "../../../tasks-ui/Dialog";
import { PickerSkeleton } from "../../drive/Picker";
import { SearchGlyph } from "../../drive/glyphs";

// La forma comune dei selettori dell'editor (shape product-editor.md
// §3.7–§3.9): un popover di 400 px al blocco, nella forma di `menu`, col
// campo di ricerca in cima e l'elenco a gruppi sotto. Il fuoco sta nel campo
// (`combobox` con `aria-activedescendant`): ↑/↓ muovono la riga attiva (in
// giro), Invio la sceglie, Esc chiude e il fuoco torna nel blocco, al
// cursore di prima. Uscire dal selettore verso un altro posto lo chiude.

export interface PickerRow {
  id: string;
  /** Il contenuto della riga (glifo, codice, nome…). */
  node: ReactNode;
}

export interface PickerGroup {
  /** L'intestazione del gruppo; `null` = un elenco senza gruppi. */
  label: string | null;
  rows: PickerRow[];
}

export function EditorPicker({
  id,
  label,
  query,
  onQuery,
  groups,
  active,
  onActive,
  loading,
  note,
  onPick,
  onClose,
  onLeave,
  style,
}: {
  id: string;
  /** Il nome del campo e dell'elenco, anche il segnaposto. */
  label: string;
  query: string;
  onQuery: (q: string) => void;
  groups: PickerGroup[];
  active: number;
  onActive: (i: number) => void;
  loading: boolean;
  /** Al posto dell'elenco vuoto: «nessun file», «nessun risultato», l'errore. */
  note: string | null;
  onPick: (rowId: string) => void;
  /** Esc: chiude, il fuoco torna nel blocco. */
  onClose: () => void;
  /** Il fuoco è uscito dal selettore verso `related` (fuori dal blocco). */
  onLeave: (related: Element | null) => void;
  style: CSSProperties;
}) {
  const field = useRef<HTMLInputElement>(null);
  const rows = groups.flatMap((g) => g.rows);
  const activeRow = rows[Math.min(active, rows.length - 1)];
  const optionId = (rowId: string) => `${id}-opt-${rowId}`;

  useLayoutEffect(() => {
    field.current?.focus();
  }, []);
  useEffect(() => {
    if (activeRow) document.getElementById(optionId(activeRow.id))?.scrollIntoView?.({ block: "nearest" });
  }, [activeRow?.id]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n > 0) onActive((Math.min(active, n - 1) + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeRow) onPick(activeRow.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  let index = -1;
  return (
    <div
      data-editor-floating=""
      style={style}
      onBlur={(e) => {
        const next = e.relatedTarget as Element | null;
        if (next && e.currentTarget.contains(next)) return;
        onLeave(next);
      }}
      className="menu-enter absolute z-[46] flex max-h-80 w-[400px] max-w-full flex-col overflow-hidden rounded-lg border border-rule-strong bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
    >
      <div className="relative flex shrink-0 items-center border-b border-rule p-1.5">
        <span className="pointer-events-none absolute left-4 text-ink-faint">
          <SearchGlyph />
        </span>
        <input
          ref={field}
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={id}
          aria-autocomplete="list"
          aria-activedescendant={activeRow ? optionId(activeRow.id) : undefined}
          placeholder={label}
          value={query}
          spellCheck={false}
          onChange={(e) => {
            onQuery(e.target.value);
            onActive(0);
          }}
          onKeyDown={onKeyDown}
          className={`${inputClass} border-transparent pl-8 hover:border-transparent`}
        />
      </div>
      <div id={id} role="listbox" aria-label={label} className="flex min-h-0 flex-col overflow-y-auto p-1.5">
        {loading && rows.length === 0 ? (
          <PickerSkeleton />
        ) : rows.length === 0 ? (
          <p className="px-2 py-2 text-sm text-ink-muted">{note}</p>
        ) : (
          groups
            .filter((g) => g.rows.length > 0)
            .map((group, gi) => (
              <div
                key={group.label ?? gi}
                role="group"
                aria-label={group.label ?? undefined}
                className="flex flex-col not-first:mt-1 not-first:border-t not-first:border-rule not-first:pt-1"
              >
                {group.label && (
                  <span aria-hidden="true" className="heading-group px-2 pt-1.5 pb-1">
                    {group.label}
                  </span>
                )}
                {group.rows.map((row) => {
                  index += 1;
                  const selected = row === activeRow;
                  const at = index;
                  return (
                    <div
                      key={row.id}
                      id={optionId(row.id)}
                      role="option"
                      aria-selected={selected}
                      // Il clic non toglie il fuoco al campo.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => onActive(at)}
                      onClick={() => onPick(row.id)}
                      className={`flex min-h-9 shrink-0 cursor-default items-center gap-2.5 rounded-md px-2 py-1 text-sm text-ink ${selected ? "bg-ink/8" : ""}`}
                    >
                      {row.node}
                    </div>
                  );
                })}
              </div>
            ))
        )}
      </div>
    </div>
  );
}
