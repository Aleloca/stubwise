import { useTranslation } from "react-i18next";

/**
 * Trigger della command palette dei Docs: un `<button>` full-width che, allo
 * stile del vecchio box di ricerca inline, apre la palette (Cmd/K). Mostra a
 * sinistra un'icona ⌕, al centro il placeholder e a destra un kbd `⌘K` statico.
 * Tutta la logica di ricerca vive in `DocsCommandPalette`; qui solo l'apertura.
 */
export function DocsSearchTrigger({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const placeholder = t("docs:palette.trigger");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("docs:palette.label")}
      className="mb-4 flex w-full items-center gap-2 rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-left text-[13px] text-fg-muted transition-colors hover:border-ink-700 hover:text-fg"
    >
      <span aria-hidden="true" className="shrink-0 text-fg-faint">
        ⌕
      </span>
      <span className="min-w-0 flex-1 truncate">{placeholder}</span>
      <kbd className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] tracking-[0.08em] text-fg-faint">
        ⌘K
      </kbd>
    </button>
  );
}
