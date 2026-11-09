import { useTranslation } from "react-i18next";
import { useProductSpaceContext } from "../parts";

// «Comment» nella barra della selezione (shape product-editor.md [PE 7],
// product-comments-history.md §3.1): dopo un divisore, in parola. C'è solo
// per chi può commentare (`docs.edit`, dalla vista) e su una selezione non
// vuota dentro UN blocco o UNA cella. Il bottone non toglie il fuoco al
// blocco (la selezione resta finché la casella non lo prende).

/** La frase citata: il solo testo scelto, senza spazi ai lati, al più 200 caratteri con «…». */
export function quoteOf(text: string): string {
  const clean = text.trim();
  return clean.length > 200 ? `${clean.slice(0, 199).trimEnd()}…` : clean;
}

export function SelectionCommentButton({ onComment }: { onComment: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <span role="separator" aria-orientation="vertical" className="mx-1 h-4 w-px bg-rule" />
      <button
        type="button"
        aria-label={t("productDocs.comments.comment")}
        title={`${t("productDocs.comments.comment")} · ⌥⌘M`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onComment}
        className="grid h-6 place-items-center rounded-md px-2 text-sm font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6"
      >
        {t("productDocs.comments.comment")}
      </button>
    </>
  );
}

/** Il gesto «Comment» per un'ancora, se chi guarda può commentare; `undefined` altrimenti. */
export function useCommentGesture(): ((anchorId: string, text: string) => void) | undefined {
  const { comments } = useProductSpaceContext();
  if (!comments?.canComment) return undefined;
  return (anchorId, text) => comments.start(anchorId, quoteOf(text));
}
