import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ProductBlock } from "../../../data/types";
import { WarningGlyph } from "../../drive/glyphs";
import type { ImageRefusal } from "./images";

// Il blocco immagine (shape product-editor.md §3.6, [PE 9]): l'immagine a
// tutta colonna, alta al più 480 (`contain`), bordo 1 px `rule`, raggio 6;
// sotto la didascalia 13/18 `ink-muted`. Chi scrive ha un campo senza bordo
// («Add a caption») che salva all'uscita; per chi legge una didascalia vuota
// non occupa spazio. Solo `data:image/…`: un indirizzo d'altro tipo non si
// carica mai (§9).

type Image = Extract<ProductBlock, { type: "image" }>;

/** Un clic sull'oggetto (non su un campo, un link o un bottone) lo seleziona. */
export const selectOnMouseDown = (onSelect?: () => void) => (e: MouseEvent) => {
  if (!onSelect || (e.target as Element).closest("a,button,input,textarea")) return;
  e.preventDefault();
  onSelect();
};

export function ImageBlock({
  block,
  onCaption,
  onSelect,
}: {
  block: Image;
  /** Chi scrive: la didascalia nuova, all'uscita dal campo. */
  onCaption?: (caption: string) => void;
  onSelect?: () => void;
}) {
  const { t } = useTranslation();
  const safe = block.src.startsWith("data:image/");
  return (
    <figure className="flex flex-col gap-1.5">
      <div onMouseDown={selectOnMouseDown(onSelect)}>
        {safe ? (
          <img
            src={block.src}
            alt={block.alt}
            draggable={false}
            className="max-h-[480px] max-w-full rounded-md border border-rule object-contain"
          />
        ) : (
          <span className="flex h-24 w-full items-center justify-center rounded-md border border-rule text-sm text-ink-muted">
            {t("productDocs.space.blockImage")}
          </span>
        )}
      </div>
      {onCaption ? (
        <figcaption>
          <CaptionField caption={block.caption} onCaption={onCaption} onDone={onSelect} />
        </figcaption>
      ) : (
        block.caption.trim() !== "" && (
          <figcaption className="text-[13px] leading-[18px] text-pretty text-ink-muted">{block.caption}</figcaption>
        )
      )}
    </figure>
  );
}

function CaptionField({
  caption,
  onCaption,
  onDone,
}: {
  caption: string;
  onCaption: (caption: string) => void;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(caption);
  const focused = useRef(false);
  // Quello che si è già mandato: un secondo blur senza cambi non scrive.
  const sent = useRef(caption);
  useEffect(() => {
    if (focused.current) return;
    setValue(caption);
    sent.current = caption;
  }, [caption]);
  return (
    <input
      type="text"
      aria-label={t("productDocs.blocks.image.captionLabel")}
      placeholder={t("productDocs.blocks.image.caption")}
      value={value}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (value === sent.current) return;
        sent.current = value;
        onCaption(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          // Il fuoco va all'immagine come oggetto (il blur salva).
          onDone?.();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setValue(sent.current);
          onDone?.();
        }
      }}
      className="w-full min-w-0 rounded-sm bg-transparent text-[13px] leading-[18px] text-ink-muted outline-none placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    />
  );
}

/**
 * Il rifiuto di un'immagine (§3.6), dove sarebbe andato il blocco: ▲ e la
 * frase, `role="alert"`, 6 s o fino a «Dismiss». Il testo si compone in
 * lettura dal motivo.
 */
export function ImageRefusalRow({ reason, onDismiss }: { reason: ImageRefusal; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex items-center gap-2 py-2 text-sm text-ink">
      <span className="text-warning">
        <WarningGlyph />
      </span>
      <span className="min-w-0 flex-1">{t(`productDocs.blocks.image.${reason}`)}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
      >
        {t("productDocs.blocks.image.dismiss")}
      </button>
    </div>
  );
}
