import { useSortable } from "@dnd-kit/sortable";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { ProductClaudeMark } from "../claude/ProductClaudeMark";
import { ThreadTint } from "../comments/CommentMark";

// L'involucro di un blocco per chi scrive: il gruppo che si seleziona come
// oggetto con Esc ([PE 5], `role="group"` col nome del tipo) e che si
// trascina per ⋮⋮ ([PE 4]). Mentre si trascina i blocchi non si spostano:
// l'origine si sbiadisce e l'arrivo è una linea di 2 px d'inchiostro fra i
// blocchi, come nell'albero ([PS 12]). Col menu ⋮⋮ aperto il blocco sta
// sopra i successivi (11b, Task 12): ogni blocco è un contesto a sé
// (`isolate`), e senza il menu finiva sotto le righe che seguono.

/**
 * Ciò che va sul SOLO ⋮⋮ (rimandi della review del Task 8): gli ascoltatori
 * del trascinamento — non sul menu che apre, che non è in un portale e in cui
 * premere e muoversi avrebbe trascinato il blocco — e la descrizione con le
 * istruzioni per il lettore di schermo.
 */
export interface DragHandle {
  listeners: ReturnType<typeof useSortable>["listeners"];
  describedBy: string | undefined;
}

export function BlockShell({
  id,
  label,
  style,
  register,
  onKeyDown,
  dropLine,
  dropNote = null,
  after = null,
  tinted = false,
  text = false,
  children,
}: {
  id: string;
  label: string;
  style: CSSProperties;
  register: (el: HTMLDivElement | null) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** La linea d'arrivo su questo blocco, se il trascinato cade qui. */
  dropLine: "top" | "bottom" | null;
  /** La nota sotto la linea d'arrivo di un file («Drop to add the image»). */
  dropNote?: string | null;
  /** Ciò che sta subito sotto il blocco (il rifiuto di un'immagine). */
  after?: ReactNode;
  /** Il blocco del filo attivo (Task 10, [PC 6]): la tinta ink 6 % a tutta larghezza. */
  tinted?: boolean;
  /**
   * Un blocco di testo: scelto come oggetto, l'anello sta 4 px fuori, così
   * non tocca la prima lettera (Impeccable 12). Gli oggetti restano a 2 px.
   */
  text?: boolean;
  /** Il contenuto; riceve ciò che va su ⋮⋮. */
  children: (handle: DragHandle) => ReactNode;
}) {
  const { setNodeRef, listeners, attributes, isDragging } = useSortable({ id });
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        register(el);
      }}
      role="group"
      data-block-id={id}
      tabIndex={-1}
      aria-label={label}
      onKeyDown={onKeyDown}
      style={style}
      className={`group/block relative rounded-lg focus:outline-2 ${text ? "focus:outline-offset-4" : "focus:outline-offset-2"} focus:outline-focus focus:outline-solid ${isDragging ? "opacity-40" : ""} isolate has-[[aria-expanded=true]]:z-20`}
    >
      {tinted && <ThreadTint />}
      {dropLine && (
        <span
          aria-hidden="true"
          data-drop-line={dropLine}
          className={`pointer-events-none absolute right-0 left-0 h-0.5 rounded-full bg-ink ${dropLine === "top" ? "-top-px" : "-bottom-px"}`}
        />
      )}
      {dropNote && (
        <span
          aria-live="polite"
          className="pointer-events-none absolute right-0 -bottom-5 z-10 rounded-sm bg-surface px-1 text-xs text-ink-muted"
        >
          {dropNote}
        </span>
      )}
      {children({ listeners, describedBy: attributes["aria-describedby"] })}
      {after}
      {/* Il segno di Claude (11b): nella corsia fuori dalla colonna, e la sua nota sotto il blocco. */}
      <ProductClaudeMark blockId={id} />
    </div>
  );
}
