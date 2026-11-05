import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { safeLinkHref } from "../../../domain/productDocs/richText";
import { primaryButton } from "../../tasks/controls";

// Il campo del link (shape product-editor.md §3.5, [PE 8]): prende il posto
// dei bottoni della barra, 320 px. Invio applica, Esc torna alla selezione.
// Un indirizzo che `safeLinkHref` rifiuta dice «Only http and https links»
// sotto il campo e NON scrive niente; su un link che c'è, «Remove link».

export function LinkField({
  initial,
  existing,
  onApply,
  onRemove,
  onCancel,
}: {
  initial: string;
  /** La selezione è già un link: si può togliere. */
  existing: boolean;
  onApply: (href: string) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const [refused, setRefused] = useState(false);
  const errorId = useId();
  const apply = () => {
    const href = safeLinkHref(value);
    if (href === null) {
      setRefused(true);
      return;
    }
    onApply(href);
  };
  return (
    <div className="flex w-[320px] flex-col gap-1 p-1">
      <div className="flex items-center gap-1">
        <input
          type="url"
          autoFocus
          value={value}
          placeholder={t("productDocs.editor.link.field")}
          aria-label={t("productDocs.editor.link.field")}
          aria-invalid={refused || undefined}
          aria-describedby={refused ? errorId : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setRefused(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md bg-ink/5 px-2 text-sm text-ink placeholder:text-ink-faint"
        />
        <button
          type="button"
          onClick={apply}
          disabled={value.trim() === ""}
          className={`${primaryButton} h-7 px-2.5 text-sm disabled:opacity-50`}
        >
          {t("productDocs.editor.link.apply")}
        </button>
      </div>
      {refused && (
        <p id={errorId} role="alert" className="flex items-center gap-1.5 px-1 text-xs text-critical">
          <svg
            viewBox="0 0 16 16"
            width={12}
            height={12}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="8" cy="8" r="6" />
            <path d="M8 4.8v3.6M8 11h0" />
          </svg>
          {t("productDocs.editor.link.refused")}
        </p>
      )}
      {existing && (
        <button
          type="button"
          onClick={onRemove}
          className="self-start rounded-md px-1 text-xs text-ink-muted hover:text-ink hover:underline"
        >
          {t("productDocs.editor.link.remove")}
        </button>
      )}
    </div>
  );
}
