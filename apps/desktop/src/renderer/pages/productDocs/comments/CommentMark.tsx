import { useTranslation } from "react-i18next";
import { useProductSpaceContext } from "../parts";

// Il segno di un blocco commentato (shape product-comments-history.md §3.4,
// [PC 6]): sul bordo destro, DENTRO la colonna di lettura (il corpo tiene
// 28 px a destra apposta: il margine fuori resta al segno di Claude del
// 11b), all'altezza della prima riga; su una tabella 28 px più giù, sotto
// il suo «⋯». È il glifo del commento 14 px `ink-faint` col numero dei fili
// aperti. Clic: la colonna sul primo filo di quel blocco. Per chi scrive e
// per chi legge. Nessun segno senza fili aperti con l'ancora viva.

/** I fili aperti sulle ancore di un blocco (il blocco, o le sue celle). */
export function useOpenThreads(anchorIds: readonly string[]): { count: number; active: boolean } {
  const { comments } = useProductSpaceContext();
  if (!comments) return { count: 0, active: false };
  const count = anchorIds.reduce((n, id) => n + (comments.counts.get(id) ?? 0), 0);
  const active = comments.activeAnchor !== null && anchorIds.includes(comments.activeAnchor);
  return { count, active };
}

/**
 * La tinta del blocco col filo attivo ([PC 6]): ink 6 % a TUTTA larghezza,
 * fin sotto il segno (i 28 px che il corpo tiene a destra), dietro al testo
 * (`isolate` sul blocco, `-z-10` qui).
 */
export function ThreadTint() {
  return (
    <span
      aria-hidden="true"
      data-thread-tint=""
      className="pointer-events-none absolute inset-y-0 left-0 -right-7 -z-10 rounded-lg bg-ink/6"
    />
  );
}

export function CommentMark({ anchorIds, below = false }: { anchorIds: readonly string[]; below?: boolean }) {
  const { t } = useTranslation();
  const { comments } = useProductSpaceContext();
  const { count } = useOpenThreads(anchorIds);
  if (!comments || count === 0) return null;
  const label = t("productDocs.comments.mark", { count });
  return (
    <button
      type="button"
      data-comment-mark=""
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => comments.openAnchor(anchorIds)}
      className={`absolute -right-7 ${below ? "top-[calc(var(--block-pt,0px)+28px)]" : "top-[var(--block-pt,0px)]"} inline-flex h-6 w-7 items-center justify-center gap-0.5 rounded-md text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink`}
    >
      <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M2.75 3.75h10.5v7h-5.5l-3 2.5v-2.5h-2Z" />
      </svg>
      <span className="num text-xs">{count}</span>
    </button>
  );
}
