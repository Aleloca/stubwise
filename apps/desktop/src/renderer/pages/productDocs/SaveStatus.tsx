import { useTranslation } from "react-i18next";
import type { EditorStatus } from "./parts";

// Lo stato di salvataggio dell'editor, primo gesto a destra della barra
// dello spazio (shape product-editor.md §3.12, [PE 15]): 12 px `ink-faint`,
// «Saving…» → «Saved» (solo dopo la risposta, e resta fino al tasto dopo);
// a riposo niente. L'errore prende il suo posto, 12 px `critical` con
// l'icona: «Couldn't save · Retry», annunciato `assertive` una volta; Retry
// rimanda le stesse operazioni. Un ⌘Z saltato perché altri hanno cambiato
// il blocco lo dice qui ([PE 21]).

export function SaveStatus({ status }: { status: EditorStatus }) {
  const { t } = useTranslation();
  if (status.state === "error") {
    return (
      <span role="alert" className="mr-1 inline-flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-critical">
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
        {t("productDocs.editor.save.failed")}
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={status.retry}
          className="rounded-sm font-semibold underline decoration-critical/40 underline-offset-2 hover:decoration-critical"
        >
          {t("productDocs.editor.save.retry")}
        </button>
      </span>
    );
  }
  const text = status.skipped
    ? t("productDocs.editor.save.notUndone")
    : status.state === "saving"
      ? t("productDocs.editor.save.saving")
      : status.state === "saved"
        ? t("productDocs.editor.save.saved")
        : "";
  return (
    <span
      role="status"
      aria-live="polite"
      className={`mr-1 shrink-0 text-xs whitespace-nowrap ${status.skipped ? "text-ink-muted" : "text-ink-faint"}`}
    >
      {text}
    </span>
  );
}
