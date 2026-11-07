import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type SlashGroup, type SlashItem, type SlashItemId } from "../../../domain/productDocs/shortcuts";

// Il menu «/» (shape product-editor.md §3.4, [PE 6]): 300 px sotto il
// cursore, la forma di `menu`; gruppi TEXT / INSERT nell'ordine di
// `SLASH_ITEMS`, righe di 32 px (glifo 16 · nome · a destra la scorciatoia
// in un tasto bordato). Il fuoco resta nel blocco: frecce, Invio ed Esc li
// prende il blocco, il menu è un `listbox` con `aria-activedescendant`.

/** Le scorciatoie digitate da mostrare accanto alle voci (§3.4). */
const SHORTCUT: Partial<Record<SlashItemId, string>> = {
  heading1: "#",
  heading2: "##",
  heading3: "###",
  bullet: "-",
  numbered: "1.",
  todo: "[]",
  quote: ">",
  divider: "---",
};

export const slashOptionId = (listId: string, item: SlashItemId) => `${listId}-${item}`;

export function SlashMenu({
  id,
  items,
  active,
  query,
  onPick,
  style,
  disabled = {},
}: {
  id: string;
  /** Le voci filtrate, nell'ordine; la attiva è `active`. */
  items: SlashItem[];
  active: number;
  query: string;
  onPick: (item: SlashItem) => void;
  style: React.CSSProperties;
  /**
   * Le voci spente, con la loro frase sotto il nome (11b: «Screen sketch» col
   * budget del mese finito). Nessun «Who?»: dentro una `listbox` non ci sono link.
   */
  disabled?: Partial<Record<SlashItemId, string>>;
}) {
  const { t } = useTranslation();
  const activeItem = items[active];
  // La voce attiva resta in vista.
  useEffect(() => {
    if (!activeItem) return;
    document.getElementById(slashOptionId(id, activeItem.id))?.scrollIntoView?.({ block: "nearest" });
  }, [id, activeItem]);
  const groups = (["text", "insert"] as SlashGroup[])
    .map((group) => ({ group, items: items.filter((i) => i.group === group) }))
    .filter((g) => g.items.length > 0);
  return (
    <div
      id={id}
      role="listbox"
      aria-label={t("productDocs.editor.slash.label")}
      data-editor-floating=""
      style={style}
      className="menu-enter absolute z-[46] flex max-h-[560px] w-[300px] flex-col overflow-y-auto rounded-lg border border-rule-strong bg-surface p-1.5 shadow-[0_12px_32px_-8px_oklch(0_0_0/0.4)]"
    >
      {groups.length === 0 && (
        <p className="px-2 py-1.5 text-sm text-ink-muted">{t("productDocs.editor.slash.empty", { q: query })}</p>
      )}
      {groups.map(({ group, items: rows }) => (
        <div
          key={group}
          role="group"
          aria-label={t(`productDocs.editor.slash.${group}`)}
          className="flex flex-col not-first:mt-1 not-first:border-t not-first:border-rule not-first:pt-1"
        >
          <span aria-hidden="true" className="heading-group px-2 pt-1.5 pb-1">
            {t(`productDocs.editor.slash.${group}`)}
          </span>
          {rows.map((item) => {
            const selected = item === activeItem;
            const shortcut = SHORTCUT[item.id];
            const off = disabled[item.id];
            return (
              <div
                key={item.id}
                id={slashOptionId(id, item.id)}
                role="option"
                aria-selected={selected}
                aria-disabled={off ? true : undefined}
                aria-labelledby={off ? `${slashOptionId(id, item.id)}-label` : undefined}
                aria-describedby={off ? `${slashOptionId(id, item.id)}-why` : undefined}
                // Il clic non toglie il fuoco al blocco.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => !off && onPick(item)}
                className={`flex shrink-0 cursor-default items-center gap-2.5 rounded-md px-2 text-sm ${off ? "min-h-8 py-1.5 text-ink-muted" : "h-8 text-ink"} ${selected ? "bg-ink/8" : off ? "" : "hover:bg-ink/5"}`}
              >
                <SlashGlyph id={item.id} />
                {off ? (
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span id={`${slashOptionId(id, item.id)}-label`} className="truncate">
                      {t(item.labelKey)}
                    </span>
                    <span id={`${slashOptionId(id, item.id)}-why`} className="text-xs text-pretty text-ink-muted">
                      {off}
                    </span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
                )}
                {shortcut && (
                  <kbd className="num rounded-[4px] border border-rule px-1 font-sans text-xs leading-4 text-ink-faint">
                    {shortcut}
                  </kbd>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Il glifo 16 px di una voce: disegnato, nello stesso tratto delle icone dell'app. */
function SlashGlyph({ id }: { id: SlashItemId }) {
  const paths: Record<SlashItemId, ReactNode> = {
    heading1: <path d="M3 3.5v9M9 3.5v9M3 8h6M11.5 6.5 13 5.5v7" />,
    heading2: <path d="M2.5 3.5v9M8 3.5v9M2.5 8H8M10.5 6.5a1.5 1.5 0 1 1 2.6 1L10.5 12.5h3" />,
    heading3: <path d="M2.5 3.5v9M8 3.5v9M2.5 8H8M10.5 5.5h3l-1.6 2.2a1.6 1.6 0 1 1-1.4 2.6" />,
    paragraph: <path d="M3 4h10M3 8h10M3 12h6" />,
    bullet: (
      <>
        <circle cx="3.5" cy="5" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="3.5" cy="11" r="0.9" fill="currentColor" stroke="none" />
        <path d="M6.5 5H13M6.5 11H13" />
      </>
    ),
    numbered: <path d="M3 3.5 4 3v4M2.8 9.5a1 1 0 1 1 1.6.8L2.8 12.5h2M7 5h6M7 11h6" />,
    todo: (
      <>
        <rect x="2.5" y="3.5" width="9" height="9" rx="1.5" />
        <path d="m5 8 1.6 1.6L9.5 6.5" />
      </>
    ),
    quote: <path d="M3.5 3.5v9M6.5 5h6.5M6.5 8h6.5M6.5 11h4" />,
    divider: <path d="M2.5 8h11M4 4.5h8M4 11.5h8" strokeOpacity={0.5} />,
    table: (
      <>
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="M2.5 6.5h11M8 6.5V13" />
      </>
    ),
    image: (
      <>
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="m4.5 11 2.5-3 2 2 1.5-1.5 1.5 2.5" />
      </>
    ),
    drive: <path d="M6 3h4l3.5 6-2 3.5h-7L2.5 9z M6 3l3.5 6M2.5 9h7" />,
    link: <path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5L8.5 4M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.5-.5" />,
    decision: <path d="M3 3.5h10v6H7l-3 3v-3H3z" />,
    // La bozza di schermata (11b): un riquadro a fil di ferro.
    wireframe: (
      <>
        <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
        <path d="M2.5 6h11M4.5 8.5h4M4.5 10.5h2.5M10 8.5h1.5v2H10z" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-ink-muted"
    >
      {paths[id]}
    </svg>
  );
}
