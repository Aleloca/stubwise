import { forwardRef, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { InlineMark, RichText } from "../../../data/types";
import { SelectionCommentButton } from "../comments/SelectionCommentButton";
import { LinkField } from "./LinkField";

// La barra della selezione (shape product-editor.md §3.5, [PE 7]): sopra
// una selezione non vuota dentro un blocco, 8 px di distanza, 32 px, la
// forma di `menu`. B (⌘B) · I (⌘I) · Link · divisore · Comment (Task 10, solo
// per chi può commentare: `onComment`).
// B e I hanno `aria-pressed` se tutta la selezione ha già il segno; col
// cursore dentro un link c'è solo Link, premuto. È un `toolbar`: frecce ←/→
// fra i bottoni, ⌥F10 dal testo. I bottoni non tolgono il fuoco al blocco.

/** Tutto [start, end) ha il segno `type`. */
export function hasMark(rt: RichText, start: number, end: number, type: InlineMark["type"]): boolean {
  if (start >= end) return false;
  for (let i = start; i < end; i++) {
    if (!rt.marks.some((m) => m.type === type && m.start <= i && i < m.end)) return false;
  }
  return true;
}

/** Il link che contiene (o copre) [start, end), se c'è. */
export function linkAt(rt: RichText, start: number, end: number): Extract<InlineMark, { type: "link" }> | null {
  const found = rt.marks.find(
    (m): m is Extract<InlineMark, { type: "link" }> =>
      m.type === "link" && (start === end ? m.start < start && start < m.end : m.start <= start && end <= m.end),
  );
  return found ?? null;
}

export const SelectionBar = forwardRef<
  HTMLDivElement,
  {
    content: RichText;
    start: number;
    end: number;
    linkOpen: boolean;
    onBold: () => void;
    onItalic: () => void;
    onLink: () => void;
    onApplyLink: (href: string) => void;
    onRemoveLink: () => void;
    onCloseLink: () => void;
    /** «Comment» sulla selezione (Task 10); assente per chi non può commentare. */
    onComment?: () => void;
    style: React.CSSProperties;
  }
>(function SelectionBar(
  { content, start, end, linkOpen, onBold, onItalic, onLink, onApplyLink, onRemoveLink, onCloseLink, onComment, style },
  ref,
) {
  const { t } = useTranslation();
  const toolbar = useRef<HTMLDivElement>(null);
  const link = linkAt(content, start, end);
  const caretOnly = start === end;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (linkOpen || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const buttons = [...(toolbar.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    buttons[(at + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div
      ref={ref}
      data-editor-floating=""
      style={style}
      className="menu-enter absolute z-[46] rounded-lg border border-rule-strong bg-surface shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
    >
      {linkOpen ? (
        <LinkField
          initial={link?.href ?? ""}
          existing={link !== null}
          onApply={onApplyLink}
          onRemove={onRemoveLink}
          onCancel={onCloseLink}
        />
      ) : (
        <div
          ref={toolbar}
          role="toolbar"
          aria-label={t("productDocs.editor.selection.toolbar")}
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          className="flex h-8 items-center gap-0.5 px-1"
        >
          {!caretOnly && (
            <>
              <BarButton
                label={t("productDocs.editor.selection.bold")}
                shortcut="⌘B"
                pressed={hasMark(content, start, end, "bold")}
                onClick={onBold}
              >
                <span aria-hidden="true" className="grid size-4 place-items-center text-[15px] leading-none font-bold">
                  B
                </span>
              </BarButton>
              <BarButton
                label={t("productDocs.editor.selection.italic")}
                shortcut="⌘I"
                pressed={hasMark(content, start, end, "italic")}
                onClick={onItalic}
              >
                <ItalicGlyph />
              </BarButton>
            </>
          )}
          <BarButton label={t("productDocs.editor.selection.link")} pressed={link !== null} onClick={onLink} wide>
            {t("productDocs.editor.selection.link")}
          </BarButton>
          {!caretOnly && onComment && <SelectionCommentButton onComment={onComment} />}
        </div>
      )}
    </div>
  );
});

/**
 * La «I» del corsivo con le grazie in cima e in fondo (Impeccable 6): l'italico
 * di Archivo è un'asta sola, e accanto al «/» dell'editor si leggeva come una barra.
 */
function ItalicGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7 3h5.5M3.5 13H9M9.75 3 6.25 13" />
    </svg>
  );
}

function BarButton({
  label,
  shortcut,
  pressed,
  onClick,
  wide = false,
  children,
}: {
  label: string;
  shortcut?: string;
  pressed: boolean;
  onClick: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? `${label} · ${shortcut}` : label}
      // Il bottone non toglie il fuoco (né la selezione) al blocco.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`grid h-6 place-items-center rounded-md text-sm text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 aria-pressed:bg-ink/10 ${wide ? "px-2 font-medium" : "w-7"}`}
    >
      {children}
    </button>
  );
}
