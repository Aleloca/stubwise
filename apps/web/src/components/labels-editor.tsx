import { useState } from "react";
import { useTranslation } from "react-i18next";

interface LabelsEditorProps {
  labels: string[];
  onChange: (labels: string[]) => void;
  disabled?: boolean;
}

/**
 * Editor delle label: chip rimovibili + campo di aggiunta (Invio o bottone).
 * Componente puro: emette la lista nuova via `onChange`, la persistenza è
 * del chiamante. Vuoti e duplicati vengono ignorati.
 */
export function LabelsEditor({ labels, onChange, disabled = false }: LabelsEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  function addDraft() {
    const label = draft.trim();
    setDraft("");
    if (!label || labels.includes(label)) return;
    onChange([...labels, label]);
  }

  return (
    <div className="flex flex-col gap-2">
      {labels.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {labels.map((label) => (
            <li
              key={label}
              className="inline-flex items-center gap-1 rounded-sm border border-line bg-ink-800/60 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted"
            >
              {label}
              <button
                type="button"
                aria-label={t("tickets:labelsEditor.removeLabel", { label })}
                disabled={disabled}
                onClick={() => onChange(labels.filter((existing) => existing !== label))}
                className="text-fg-faint transition-colors hover:text-danger disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-1.5">
        <input
          id="labels-input"
          aria-label={t("tickets:labelsEditor.newLabel")}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addDraft();
            }
          }}
          placeholder={t("tickets:labelsEditor.addPlaceholder")}
          className="min-w-0 flex-1 rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 font-mono text-[12px] text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
        />
        <button
          type="button"
          onClick={addDraft}
          disabled={disabled}
          className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg disabled:opacity-50"
        >
          {t("tickets:labelsEditor.add")}
        </button>
      </div>
    </div>
  );
}
