import { useTranslation } from "react-i18next";
import type { SlashItemId } from "../../../domain/productDocs/shortcuts";
import { itemClass } from "../../../tasks-ui/Menu";
import { MenuButton } from "../../tasks/controls";
import type { DragHandle } from "./BlockShell";

// Il gutter di un blocco (shape product-editor.md §3.3, [PE 4]): 48 px a
// sinistra della colonna, all'altezza della prima riga, solo per chi
// scrive. «+» mette un paragrafo vuoto sotto e ci apre il menu «/»; ⋮⋮
// si trascina (`dragListeners`, [PE 4]) e al clic apre il menu del blocco: Turn into ▸ (i tipi di testo, solo per un
// blocco di testo) · Move up · Move down · Duplicate · Delete. Le voci
// impossibili restano, spente con la loro frase. Compare al passaggio e
// col fuoco nel blocco. «Comment» (Task 10, P22: il gesto da tastiera,
// con la frase intera) per chi può commentare un blocco di testo.

/** I tipi in cui si trasforma un blocco di testo, nell'ordine del menu «/». */
export const TURN_INTO: SlashItemId[] = [
  "heading1",
  "heading2",
  "heading3",
  "paragraph",
  "bullet",
  "numbered",
  "todo",
  "quote",
];

const gutterButton =
  "grid size-5 place-items-center rounded-[4px] text-ink-faint transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink";

export function BlockHandle({
  label,
  line,
  isText,
  first,
  last,
  onAdd,
  onTurnInto,
  onMove,
  onDuplicate,
  onDelete,
  onComment,
  drag,
}: {
  /** Di quale blocco (per il nome dei bottoni). */
  label: string;
  /** L'altezza della prima riga del blocco, per stare alla sua altezza. */
  line: number;
  isText: boolean;
  first: boolean;
  last: boolean;
  onAdd: () => void;
  onTurnInto: (to: SlashItemId) => void;
  onMove: (dir: "up" | "down") => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** «Comment» con la frase intera (Task 10); assente per chi non può commentare. */
  onComment?: () => void;
  /** Il trascinamento (dnd-kit), sul solo ⋮⋮: un clic senza movimento resta il menu. */
  drag?: DragHandle;
}) {
  const { t } = useTranslation();
  const disabled = (reason: string, text: string) => (
    <button
      type="button"
      role="menuitem"
      aria-disabled="true"
      tabIndex={-1}
      className={`${itemClass} cursor-default flex-col items-start gap-0 hover:bg-transparent`}
    >
      <span className="text-ink-muted">{text}</span>
      <span className="text-xs text-ink-muted">{reason}</span>
    </button>
  );
  const item = (text: string, run: () => void, close: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`${itemClass} ${danger ? "text-critical" : ""}`}
      onClick={() => {
        close();
        run();
      }}
    >
      {text}
    </button>
  );
  return (
    <div
      data-block-gutter=""
      style={{ height: line }}
      className="absolute top-[var(--block-pt,0px)] -left-12 flex w-12 items-center justify-end gap-0.5 pr-1.5 opacity-0 transition-opacity duration-[var(--duration-fast)] ease-out group-focus-within/block:opacity-100 group-hover/block:opacity-100 has-[[aria-expanded=true]]:opacity-100"
    >
      <button
        type="button"
        aria-label={t("productDocs.editor.handle.add")}
        title={t("productDocs.editor.handle.add")}
        // Il clic non toglie il fuoco al blocco prima di sapere dove va.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onAdd}
        className={gutterButton}
      >
        <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="M8 3.5v9M3.5 8h9" />
        </svg>
      </button>
      <MenuButton
        menuLabel={t("productDocs.editor.handle.menu")}
        ariaLabel={`${t("productDocs.editor.handle.menu")} · ${label}`}
        title={t("productDocs.editor.handle.hint")}
        className={`${gutterButton} cursor-grab active:cursor-grabbing`}
        wrapperClassName="inline-flex shrink-0"
        buttonProps={{ ...drag?.listeners, "aria-describedby": drag?.describedBy }}
        label={
          <svg viewBox="0 0 16 16" width={14} height={14} fill="currentColor" aria-hidden="true" focusable="false">
            <circle cx="6" cy="4" r="1.1" />
            <circle cx="10" cy="4" r="1.1" />
            <circle cx="6" cy="8" r="1.1" />
            <circle cx="10" cy="8" r="1.1" />
            <circle cx="6" cy="12" r="1.1" />
            <circle cx="10" cy="12" r="1.1" />
          </svg>
        }
      >
        {(close) => (
          <>
            {isText && (
              <div role="group" aria-label={t("productDocs.editor.handle.turnInto")} className="flex flex-col">
                <span aria-hidden="true" className="heading-group px-2 pt-1.5 pb-1">
                  {t("productDocs.editor.handle.turnInto")}
                </span>
                {TURN_INTO.map((to) => (
                  <span key={to} className="contents">
                    {item(t(`productDocs.editor.slash.${to}`), () => onTurnInto(to), close)}
                  </span>
                ))}
                <div role="separator" className="my-1 h-px bg-rule" />
              </div>
            )}
            {first
              ? disabled(t("productDocs.editor.handle.alreadyFirst"), t("productDocs.editor.handle.moveUp"))
              : item(t("productDocs.editor.handle.moveUp"), () => onMove("up"), close)}
            {last
              ? disabled(t("productDocs.editor.handle.alreadyLast"), t("productDocs.editor.handle.moveDown"))
              : item(t("productDocs.editor.handle.moveDown"), () => onMove("down"), close)}
            {item(t("productDocs.editor.handle.duplicate"), onDuplicate, close)}
            {onComment && item(t("productDocs.comments.comment"), onComment, close)}
            <div role="separator" className="my-1 h-px bg-rule" />
            {item(t("productDocs.editor.handle.delete"), onDelete, close, true)}
          </>
        )}
      </MenuButton>
    </div>
  );
}
