import { useTranslation } from "react-i18next";
import type { ProductBlock } from "../../../data/types";
import { RichView } from "./RichView";

// «Mostra le due versioni» (21 nov 2026, maintainer via orchestratrice; shape
// product-editor.md, emendamento omonimo): sotto il blocco com'è nella
// pagina, la versione propria non salvata di una scrittura scartata. Bordo
// 1 px `rule`, raggio 6, fondo `surface`; la testata 12 px `ink-muted`, il
// testo coi suoi segni 15 px `ink-muted` (si può selezionare e copiare),
// poi «Use mine» e «Discard». Se un altro ha tolto il blocco, il riquadro
// sta dove il blocco era e la testata lo dice.

const textButton =
  "inline-flex h-6 items-center rounded-[4px] px-1.5 text-xs font-semibold text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink";

export function OwnVersionBox({
  own,
  deleted,
  onUse,
  onDiscard,
}: {
  own: ProductBlock;
  /** Il blocco non c'è più nella pagina: «Use mine» lo rimette. */
  deleted: boolean;
  onUse: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  if (!("content" in own)) return null;
  return (
    <div
      role="group"
      aria-label={t("productDocs.editor.own.label")}
      data-own-version={own.id}
      contentEditable={false}
      className="mt-1 rounded-md border border-rule bg-surface px-3 py-2"
    >
      <p className="text-xs text-ink-muted">
        {t("productDocs.editor.own.label")}
        {deleted && <> · {t("productDocs.editor.own.deleted")}</>}
      </p>
      <p className="mt-1 text-[15px] leading-relaxed whitespace-pre-wrap text-ink-muted select-text">
        <RichView content={own.content} links={false} />
      </p>
      <div className="mt-1 -ml-1.5 flex flex-wrap items-center gap-0.5">
        <button type="button" onClick={onUse} className={textButton}>
          {t("productDocs.editor.own.useMine")}
        </button>
        <button type="button" onClick={onDiscard} className={textButton}>
          {t("productDocs.editor.own.discard")}
        </button>
      </div>
    </div>
  );
}
