import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ProductBlock, ProductPageView, ProductPresenceView, RichText } from "../../../data/types";
import { anchorIdsOf, isTextBlock } from "../../../domain/productDocs/blocks";
import { ProductClaudeMark } from "../claude/ProductClaudeMark";
import { CommentMark, ThreadTint } from "../comments/CommentMark";
import { RemoteCursors } from "../live/RemoteCursor";
import { useProductSpaceContext } from "../parts";
import { DecisionBlock } from "./DecisionBlock";
import { DriveBlock } from "./DriveBlock";
import { ImageBlock } from "./ImageBlock";
import { RichReadOnly } from "./RichBlock";
import { TableBlock, type TableEditing } from "./TableBlock";
import { WireframeBlock, type WireframeEditing } from "./WireframeBlock";

// Il disegno dei blocchi, comune a chi legge e a chi scrive (shape
// product-editor.md §3.2): spazi, tipografia, il nome accessibile, ciò che
// sta intorno al testo (titolo, segno d'elenco, casella, citazione) e i
// blocchi che non sono testo (Task 9). Più la pagina per chi legge
// soltanto: nessun `contenteditable`, i blocchi vuoti non occupano spazio.

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

export function ReadOnlyBody({
  page,
  others = [],
}: {
  page: ProductPageView;
  /** Gli altri presenti: i loro cursori nel testo letto (Task 11). */
  others?: readonly ProductPresenceView[];
}) {
  const numbers = numbersOf(page.blocks);
  const { comments } = useProductSpaceContext();
  return (
    <div data-editor-body="" className="flex flex-col pr-7">
      {page.blocks.map((block, i) => {
        // I blocchi vuoti non occupano spazio per chi legge (§5).
        if (isTextBlock(block) && block.content.text.trim() === "") return null;
        const { pt, pb, gutterTop } = layoutOf(block);
        const anchors = anchorIdsOf(block);
        // Il blocco del filo attivo ha la tinta (Task 10, [PC 6]), anche per chi legge.
        const tinted = !!comments?.activeAnchor && anchors.includes(comments.activeAnchor);
        return (
          <div
            key={block.id}
            data-block-id={block.id}
            style={{ paddingTop: pt, paddingBottom: pb, ["--block-pt" as string]: `${gutterTop}px` }}
            className="relative isolate rounded-lg"
          >
            {tinted && <ThreadTint />}
            <CommentMark anchorIds={anchors} below={block.type === "table"} />
            {isTextBlock(block) && (
              <RemoteCursors
                people={others.filter((p) => p.anchorId === block.id)}
                contentKey={JSON.stringify(block.content)}
              />
            )}
            <BlockBody block={block} page={page} number={numbers[i]!}>
              {isTextBlock(block) && (
                <RichReadOnly
                  content={block.content}
                  className={textClassOf(block, block.type === "todo" && block.checked)}
                  liveId={block.id}
                />
              )}
            </BlockBody>
            {/* Il segno di Claude (11b): anche per chi legge soltanto (decisione 5). */}
            <ProductClaudeMark blockId={block.id} />
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
    case "wireframe":
      return t("productDocs.space.blockWireframe");
  }
}

/**
 * Ciò che sta intorno al testo di un blocco: il titolo (h2–h4), il segno
 * dell'elenco, la casella, il filetto della citazione; e i blocchi che non
 * sono testo (Task 9): immagine, file del Drive, decisione, tabella.
 */
export function BlockBody({
  block,
  page,
  number,
  onCheck,
  onSelectObject,
  onCaption,
  table,
  sketch,
  children,
}: {
  block: ProductBlock;
  page: ProductPageView;
  number: number;
  onCheck?: (checked: boolean) => void;
  onSelectObject?: () => void;
  /** Chi scrive: la didascalia nuova di un'immagine. */
  onCaption?: (caption: string) => void;
  /** Chi scrive: la tabella si scrive cella per cella. */
  table?: TableEditing;
  /** Chi scrive: i gesti della bozza di schermata (11b). */
  sketch?: WireframeEditing;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { project } = useProductSpaceContext();
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
    case "image":
      return <ImageBlock block={block} onCaption={onCaption} onSelect={onSelectObject} />;
    case "drive":
      return <DriveBlock block={block} onSelect={onSelectObject} />;
    case "decision":
      return (
        <DecisionBlock block={block} decisions={page.decisions} projectCode={project.code} onSelect={onSelectObject} />
      );
    case "table":
      return <TableBlock block={block} editing={table} />;
    case "wireframe":
      return (
        <WireframeBlock
          block={block}
          page={page}
          projectId={project.id}
          projectCode={project.code}
          editing={sketch}
          onSelect={onSelectObject}
        />
      );
  }
}
