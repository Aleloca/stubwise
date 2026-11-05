import { useSortable } from "@dnd-kit/sortable";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

// L'involucro di un blocco per chi scrive: il gruppo che si seleziona come
// oggetto con Esc ([PE 5], `role="group"` col nome del tipo) e che si
// trascina per ⋮⋮ ([PE 4]). Mentre si trascina i blocchi non si spostano:
// l'origine si sbiadisce e l'arrivo è una linea di 2 px d'inchiostro fra i
// blocchi, come nell'albero ([PS 12]).

export type DragHandleListeners = ReturnType<typeof useSortable>["listeners"];

export function BlockShell({
  id,
  label,
  style,
  register,
  onKeyDown,
  dropLine,
  children,
}: {
  id: string;
  label: string;
  style: CSSProperties;
  register: (el: HTMLDivElement | null) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** La linea d'arrivo su questo blocco, se il trascinato cade qui. */
  dropLine: "top" | "bottom" | null;
  /** Il contenuto; riceve gli ascoltatori da mettere su ⋮⋮. */
  children: (handle: DragHandleListeners) => ReactNode;
}) {
  const { setNodeRef, listeners, isDragging } = useSortable({ id });
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
      className={`group/block relative rounded-lg focus:outline-2 focus:outline-offset-2 focus:outline-focus focus:outline-solid ${isDragging ? "opacity-40" : ""}`}
    >
      {dropLine && (
        <span
          aria-hidden="true"
          data-drop-line={dropLine}
          className={`pointer-events-none absolute right-0 left-0 h-0.5 rounded-full bg-ink ${dropLine === "top" ? "-top-px" : "-bottom-px"}`}
        />
      )}
      {children(listeners)}
    </div>
  );
}
