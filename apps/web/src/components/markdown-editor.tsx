import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "./markdown";

interface MarkdownEditorProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  "aria-label"?: string;
}

/** Selezione da riposizionare dopo il re-render conseguente a onChange. */
interface PendingSelection {
  start: number;
  end: number;
}

/**
 * Editor markdown controllato in stile sala controllo: tab Write/Preview, una
 * toolbar che avvolge la selezione corrente nella sintassi markdown e una
 * textarea. Non gestisce il submit: si limita a propagare il valore via
 * `onChange`, così il chiamante resta padrone dello stato e dell'invio. La
 * Preview riusa il renderer `Markdown` (marked + sanitize), niente HTML grezzo.
 */
export function MarkdownEditor({
  id,
  value,
  onChange,
  placeholder,
  rows = 4,
  "aria-label": ariaLabel,
}: MarkdownEditorProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"write" | "preview">("write");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Selezione richiesta da un'azione toolbar: il valore cambia tramite onChange
  // (componente controllato), quindi il riposizionamento del cursore va fatto
  // dopo il re-render con il nuovo `value` montato.
  const pendingSelection = useRef<PendingSelection | null>(null);

  useLayoutEffect(() => {
    const target = pendingSelection.current;
    const textarea = textareaRef.current;
    if (!target || !textarea) return;
    pendingSelection.current = null;
    textarea.focus();
    textarea.setSelectionRange(target.start, target.end);
  });

  /**
   * Applica una trasformazione alla selezione corrente: legge start/end dalla
   * textarea (con fallback difensivo a fine testo se l'ambiente non espone la
   * selezione), produce il nuovo valore e la nuova selezione, propaga via
   * onChange e parcheggia la selezione per il riposizionamento post-render.
   */
  function applyEdit(transform: (selected: string) => { text: string; selectionOffset?: number }) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end);

    const { text, selectionOffset } = transform(selected);
    const newValue = value.slice(0, start) + text + value.slice(end);

    // Selezione vuota: il cursore va dove indicato dall'azione (di norma in
    // mezzo ai marcatori). Selezione presente: si seleziona il testo inserito.
    if (start === end) {
      const caret = start + (selectionOffset ?? text.length);
      pendingSelection.current = { start: caret, end: caret };
    } else {
      pendingSelection.current = { start, end: start + text.length };
    }

    onChange(newValue);
  }

  /** Avvolge la selezione tra due marcatori; vuota → marcatori col cursore in mezzo. */
  function wrap(marker: string) {
    applyEdit((selected) => ({
      text: `${marker}${selected}${marker}`,
      selectionOffset: marker.length,
    }));
  }

  function insertLink() {
    applyEdit((selected) => ({
      text: `[${selected}](url)`,
      // Selezione vuota: cursore tra le parentesi quadre, pronto per il testo.
      selectionOffset: 1,
    }));
  }

  /** Prefissa "- " a ogni riga della selezione (o alla riga corrente se vuota). */
  function addListPrefix() {
    applyEdit((selected) => {
      const text = selected
        .split("\n")
        .map((line) => `- ${line}`)
        .join("\n");
      return { text, selectionOffset: text.length };
    });
  }

  const emptyPreview = value.trim() === "";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1" role="tablist">
        <ModeTab
          active={mode === "write"}
          label={t("tickets:editor.write")}
          onClick={() => setMode("write")}
        />
        <ModeTab
          active={mode === "preview"}
          label={t("tickets:editor.preview")}
          onClick={() => setMode("preview")}
        />
      </div>

      {mode === "write" ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <ToolbarButton label={t("tickets:editor.bold")} onClick={() => wrap("**")}>
              B
            </ToolbarButton>
            <ToolbarButton label={t("tickets:editor.italic")} onClick={() => wrap("*")}>
              <span className="italic">I</span>
            </ToolbarButton>
            <ToolbarButton label={t("tickets:editor.code")} onClick={() => wrap("`")}>
              <span className="font-mono">{"<>"}</span>
            </ToolbarButton>
            <ToolbarButton label={t("tickets:editor.link")} onClick={insertLink}>
              {"\u{1F517}"}
            </ToolbarButton>
            <ToolbarButton label={t("tickets:editor.list")} onClick={addListPrefix}>
              {"≡"}
            </ToolbarButton>
          </div>

          <textarea
            ref={textareaRef}
            id={id}
            rows={rows}
            placeholder={placeholder}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-label={ariaLabel}
            className="w-full rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-sm text-fg placeholder:text-fg-faint transition-colors hover:border-ink-700 focus-visible:border-signal-dim"
          />
        </div>
      ) : (
        <div className="min-h-[6rem] rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2">
          {emptyPreview ? (
            <p className="font-mono text-[12px] text-fg-faint">{t("tickets:editor.emptyPreview")}</p>
          ) : (
            <Markdown source={value} />
          )}
        </div>
      )}
    </div>
  );
}

/** Tab Write/Preview: `type="button"` per non scatenare il submit del form. */
function ModeTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-sm px-2 py-1 font-mono text-[11px] tracking-[0.08em] uppercase transition-colors ${
        active
          ? "bg-ink-800 text-fg"
          : "text-fg-faint hover:text-fg-muted"
      }`}
    >
      {label}
    </button>
  );
}

/** Bottone toolbar: `type="button"` per non scatenare il submit del form. */
function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 min-w-7 place-items-center rounded-sm border border-line-strong px-1.5 text-[12px] font-semibold text-fg-muted transition-colors hover:border-ink-700 hover:text-fg"
    >
      {children}
    </button>
  );
}
