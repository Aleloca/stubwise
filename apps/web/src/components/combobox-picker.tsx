import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

/** Numero massimo di voci renderizzate nella lista di un picker combobox. */
export const PICKER_MAX = 50;

/** Etichette localizzate di un {@link ComboboxPicker}. */
export interface PickerLabels {
  /** aria-label del combobox e della listbox. */
  pickerLabel: string;
  placeholder: string;
  /** Riga mostrata quando nessuna voce combacia con la query. */
  noResults: string;
  cancel: string;
  /** Testo della riga "+N altri" quando la lista è troncata (count già dato). */
  moreResults: (count: number) => string;
}

/**
 * Consente al picker di confermare un valore DIGITATO che non compare tra le
 * opzioni (es. un'email git non ancora osservata dal poller). Un bottone sotto
 * la lista e l'Invio a fuoco vuoto (nessuna opzione attiva selezionabile) lo
 * confermano.
 */
export interface PickerFreeText {
  /** True se il testo corrente è inviabile come valore libero. */
  canSubmit: (query: string) => boolean;
  /** Etichetta del bottone "collega questo valore". */
  label: (query: string) => string;
  onSubmit: (query: string) => void;
}

/**
 * Combobox generico con ricerca/autocomplete, riusato dai picker di /team
 * (membri Slack, autori git) e di /activity (link di un membro a un'email git).
 * L'input filtra le voci mentre si digita (via `matches`); la lista è
 * scrollabile e cappata a {@link PICKER_MAX} voci con una riga "+N altri" quando
 * è troncata. Le voci `isDisabled` restano elencate ma non selezionabili (le
 * frecce le saltano, il click/Invio non le sceglie), così l'utente capisce
 * perché non sono scegliibili. L'aspetto della singola opzione è delegato a
 * `renderOption`. Navigazione con ↑/↓/Invio; Esc chiama `onCancel`. `freeText`
 * (opzionale) abilita l'invio di un valore digitato fuori lista.
 */
export function ComboboxPicker<T>({
  items,
  getKey,
  matches,
  isDisabled,
  renderOption,
  onPick,
  pending,
  pendingLabel,
  onCancel,
  labels,
  freeText,
}: {
  items: T[];
  getKey: (item: T) => string;
  /** Predicato di filtro: `query` è già normalizzata (trim + lowercase). */
  matches: (item: T, query: string) => boolean;
  isDisabled: (item: T) => boolean;
  renderOption: (item: T, state: { active: boolean; disabled: boolean }) => ReactNode;
  onPick: (item: T) => void;
  pending: boolean;
  pendingLabel: string;
  onCancel: () => void;
  labels: PickerLabels;
  freeText?: PickerFreeText;
}) {
  const [query, setQuery] = useState("");
  // Indice attivo iniziale: prima voce selezionabile (le disabilitate sono
  // saltate dalle frecce e non selezionabili con Invio).
  const [active, setActive] = useState(() => items.findIndex((item) => !isDisabled(item)));
  const listboxId = useId();
  // Id di base per gli id stabili delle option, così l'input può esporre
  // `aria-activedescendant` verso l'opzione attiva (a11y per screen reader).
  const optionBaseId = useId();
  const optionId = (index: number) => `${optionBaseId}-option-${index}`;

  function filtered(value: string): T[] {
    const q = value.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => matches(item, q));
  }

  // Filtro + cap a PICKER_MAX voci renderizzate, col conteggio del troncamento
  // per la riga "+N altri". Ricalcolato a ogni render: liste piccole, costo
  // trascurabile, e nessuna dipendenza stale sulle callback props.
  const all = filtered(query);
  const visible = all.slice(0, PICKER_MAX);
  const overflow = Math.max(0, all.length - PICKER_MAX);

  // La listbox è renderizzata quando la mutation non è in corso: aria-expanded
  // deve riflettere esattamente questa visibilità, non lo stato di pending.
  const listboxOpen = !pending;

  function pick(item: T) {
    if (isDisabled(item)) return;
    onPick(item);
  }

  // Prossimo indice selezionabile in direzione `step`, partendo da `from`. Le
  // frecce saltano le voci disabilitate; se non ce n'è nessuna in quella
  // direzione, l'indice resta invariato.
  function nextSelectable(from: number, step: 1 | -1): number {
    for (let i = from + step; i >= 0 && i < visible.length; i += step) {
      const item = visible[i];
      if (item && !isDisabled(item)) return i;
    }
    return from;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => nextSelectable(i, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => nextSelectable(i, -1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = visible[active];
      if (item && !isDisabled(item)) {
        pick(item);
        return;
      }
      // Nessuna opzione attiva selezionabile: ripiega sul valore libero.
      if (freeText && freeText.canSubmit(query)) freeText.onSubmit(query);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          role="combobox"
          aria-expanded={listboxOpen}
          aria-controls={listboxId}
          aria-activedescendant={
            listboxOpen && active >= 0 && active < visible.length ? optionId(active) : undefined
          }
          aria-autocomplete="list"
          aria-label={labels.pickerLabel}
          placeholder={labels.placeholder}
          disabled={pending}
          value={query}
          onChange={(event) => {
            const value = event.target.value;
            setQuery(value);
            // L'indice attivo punta alla prima voce selezionabile dei nuovi
            // risultati: -1 se non ce ne sono, così Invio non seleziona mai una
            // voce disabilitata (ripiega semmai sul valore libero).
            const next = filtered(value).slice(0, PICKER_MAX);
            setActive(next.findIndex((item) => !isDisabled(item)));
          }}
          onKeyDown={handleKeyDown}
          className="w-full rounded-sm border border-line-strong bg-ink-950 px-2 py-1 font-mono text-[12px] text-fg placeholder:text-fg-faint disabled:opacity-50 sm:w-64"
        />
        {pending ? (
          <span className="font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase">
            {pendingLabel}
          </span>
        ) : (
          <button
            type="button"
            onClick={onCancel}
            className="tap rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors hover:text-fg"
          >
            {labels.cancel}
          </button>
        )}
      </div>

      {!pending && (
        <>
          <ul
            id={listboxId}
            role="listbox"
            aria-label={labels.pickerLabel}
            className="max-h-56 w-full overflow-y-auto rounded-sm border border-line bg-ink-950 sm:w-72"
          >
            {visible.length === 0 ? (
              <li className="px-2 py-2 font-mono text-[11px] text-fg-faint">{labels.noResults}</li>
            ) : (
              visible.map((item, index) => {
                const disabled = isDisabled(item);
                const isActive = index === active;
                return (
                  <li
                    key={getKey(item)}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isActive}
                    aria-disabled={disabled}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(item)}
                    className={`flex items-center gap-2 px-2 py-1.5 font-mono text-[12px] ${
                      disabled
                        ? "cursor-not-allowed text-fg-faint"
                        : `cursor-pointer text-fg ${isActive ? "bg-signal/10" : ""}`
                    }`}
                  >
                    {renderOption(item, { active: isActive, disabled })}
                  </li>
                );
              })
            )}
          </ul>
          {overflow > 0 && (
            <p className="font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase">
              {labels.moreResults(overflow)}
            </p>
          )}
          {freeText && freeText.canSubmit(query) && (
            <button
              type="button"
              onClick={() => freeText.onSubmit(query)}
              className="tap self-start rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors hover:border-signal-dim/40 hover:text-signal"
            >
              {freeText.label(query)}
            </button>
          )}
        </>
      )}
    </div>
  );
}
