import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ProductBlock, ProductPageView, RichText } from "../../../data/types";
import { isTextBlock } from "../../../domain/productDocs/blocks";
import { RichReadOnly } from "./RichBlock";

// Il disegno dei blocchi, comune a chi legge e a chi scrive (shape
// product-editor.md §3.2): spazi, tipografia, il nome accessibile, ciò che
// sta intorno al testo (titolo, segno d'elenco, casella, citazione) e i
// segnaposti dei blocchi che il Task 9 disegnerà. Più la pagina per chi
// legge soltanto: nessun `contenteditable`, i blocchi vuoti non occupano
// spazio.

export type TextBlock = Extract<ProductBlock, { content: RichText }>;

/** Lo spazio sopra e sotto, e l'altezza della prima riga (per la maniglia), dalla tabella §3.2. */
export function layoutOf(block: ProductBlock): { pt: number; pb: number; line: number; gutterTop: number } {
  switch (block.type) {
    case "heading":
      return [
        { pt: 28, pb: 8, line: 26, gutterTop: 28 },
        { pt: 20, pb: 6, line: 22, gutterTop: 20 },
        { pt: 16, pb: 4, line: 20, gutterTop: 16 },
      ][block.level - 1]!;
    case "paragraph":
      return { pt: 0, pb: 8, line: 22, gutterTop: 0 };
    case "bullet":
    case "numbered":
    case "todo":
      return { pt: 0, pb: 4, line: 22, gutterTop: 0 };
    case "quote":
      return { pt: 8, pb: 8, line: 22, gutterTop: 8 };
    case "divider":
      return { pt: 16, pb: 16, line: 20, gutterTop: 6 };
    default:
      return { pt: 12, pb: 12, line: 20, gutterTop: 21 };
  }
}

const TEXT_CLASS: Record<string, string> = {
  heading1: "text-xl font-semibold text-balance text-ink",
  heading2: "text-lg font-semibold text-balance text-ink",
  heading3: "text-md font-semibold text-ink",
  paragraph: "text-md leading-[22px] text-pretty text-ink",
  list: "text-md leading-[22px] text-ink",
  quote: "text-md leading-[22px] text-ink-muted",
};

export const textClassOf = (block: TextBlock, checked = false) =>
  block.type === "heading"
    ? TEXT_CLASS[`heading${block.level}`]!
    : block.type === "quote"
      ? TEXT_CLASS.quote!
      : block.type === "paragraph"
        ? TEXT_CLASS.paragraph!
        : `${TEXT_CLASS.list!}${checked ? " text-ink-muted" : ""}`;

/** Le voci numerate contano di fila, per rientro; un altro blocco riparte da 1. */
export function numbersOf(blocks: readonly ProductBlock[]): number[] {
  const counters: number[] = [];
  return blocks.map((block) => {
    if (block.type !== "numbered") {
      counters.length = 0;
      return 0;
    }
    counters.length = block.indent + 1;
    counters[block.indent] = (counters[block.indent] ?? 0) + 1;
    return counters[block.indent]!;
  });
}

// --- chi legge soltanto ------------------------------------------------------

export function ReadOnlyBody({ page }: { page: ProductPageView }) {
  const numbers = numbersOf(page.blocks);
  return (
    <div data-editor-body="" className="flex flex-col">
      {page.blocks.map((block, i) => {
        // I blocchi vuoti non occupano spazio per chi legge (§5).
        if (isTextBlock(block) && block.content.text.trim() === "") return null;
        const { pt, pb } = layoutOf(block);
        return (
          <div key={block.id} data-block-id={block.id} style={{ paddingTop: pt, paddingBottom: pb }}>
            <BlockBody block={block} page={page} number={numbers[i]!}>
              {isTextBlock(block) && (
                <RichReadOnly content={block.content} className={textClassOf(block, block.type === "todo" && block.checked)} />
              )}
            </BlockBody>
          </div>
        );
      })}
    </div>
  );
}

/** Il nome accessibile di un blocco, dal tipo (§7). */
export function blockLabel(block: ProductBlock, t: (key: string, opts?: Record<string, unknown>) => string): string {
  switch (block.type) {
    case "heading":
      return t("productDocs.editor.blocks.heading", { level: block.level });
    case "bullet":
    case "numbered":
      return t(`productDocs.editor.blocks.${block.type}`, { level: block.indent + 1 });
    case "paragraph":
    case "todo":
    case "quote":
    case "divider":
      return t(`productDocs.editor.blocks.${block.type}`);
    case "table":
      return t("productDocs.space.blockTable");
    case "image":
      return t("productDocs.space.blockImage");
    case "drive":
      return t("productDocs.space.blockDrive", { code: block.code });
    case "decision":
      return t("productDocs.space.blockDecision");
  }
}

/**
 * Ciò che sta intorno al testo di un blocco: il titolo (h2–h4), il segno
 * dell'elenco, la casella, il filetto della citazione; e i blocchi che non
 * sono testo, finché il Task 9 non li disegna (un segnaposto da leggere).
 */
export function BlockBody({
  block,
  page,
  number,
  onCheck,
  onSelectObject,
  children,
}: {
  block: ProductBlock;
  page: ProductPageView;
  number: number;
  onCheck?: (checked: boolean) => void;
  onSelectObject?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  switch (block.type) {
    case "heading": {
      const Tag = (["h2", "h3", "h4"] as const)[block.level - 1]!;
      return <Tag>{children}</Tag>;
    }
    case "paragraph":
      return <>{children}</>;
    case "quote":
      return <blockquote className="border-l-2 border-rule-strong pl-3">{children}</blockquote>;
    case "bullet":
    case "numbered":
      return (
        <div style={{ paddingLeft: 24 * (block.indent + 1) }} className="relative">
          <span
            aria-hidden="true"
            style={{ left: 24 * block.indent }}
            className="num absolute top-0 w-6 pr-2 text-right text-md leading-[22px] text-ink-muted"
          >
            {block.type === "bullet" ? "•" : `${number}.`}
          </span>
          {children}
        </div>
      );
    case "todo":
      return (
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={block.checked}
            disabled={!onCheck}
            aria-label={t("productDocs.editor.blocks.done")}
            onChange={(e) => onCheck?.(e.target.checked)}
            className="mt-[3px] size-4 shrink-0 accent-ink disabled:opacity-100"
          />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      );
    case "divider":
      return <hr className="border-rule" onMouseDown={onSelectObject} />;
    default:
      return <Placeholder block={block} page={page} onSelect={onSelectObject} />;
  }
}

/** Un blocco che il Task 9 disegnerà: una riga tenue da leggere (ruling P17). */
function Placeholder({
  block,
  page,
  onSelect,
}: {
  block: Exclude<ProductBlock, { content: RichText }>;
  page: ProductPageView;
  onSelect?: () => void;
}) {
  const { t } = useTranslation();
  let text: string;
  switch (block.type) {
    case "table":
      text = t("productDocs.space.blockTable");
      break;
    case "image":
      text = block.caption || t("productDocs.space.blockImage");
      break;
    case "drive":
      text = t("productDocs.space.blockDrive", { code: block.code });
      break;
    case "decision": {
      // Una decisione che chi legge non vede non dice titolo né data (R-G5).
      const d = page.decisions[block.decisionId];
      text = d ? d.title : t("productDocs.space.blockDecision");
      break;
    }
    default:
      text = "";
  }
  return (
    <p
      data-block-placeholder={block.type}
      onMouseDown={(e) => {
        if (!onSelect) return;
        e.preventDefault();
        onSelect();
      }}
      className="rounded-lg border border-dashed border-rule px-3 py-2 text-sm text-ink-muted"
    >
      {text}
    </p>
  );
}
