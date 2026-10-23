import { useTranslation } from "react-i18next";
import type { TaskSize } from "../data/types";

/**
 * La taglia di una task: la sola lettera (XS…XL), mai il peso. Senza stima
 * un trattino, che da solo non dice niente: per questo ha l'etichetta
 * accessibile e il `title` «No estimate».
 */
export function SizeMark({ size }: { size: TaskSize | null }) {
  const { t } = useTranslation();
  if (size === null) {
    const none = t("taskUi.size.none");
    return (
      <span
        role="img"
        aria-label={none}
        title={none}
        data-size="none"
        className="text-sm text-ink-faint"
      >
        —
      </span>
    );
  }
  return (
    <span
      data-size={size}
      title={t("taskUi.size.label", { size })}
      className="num text-xs font-semibold tracking-[0.02em] text-ink-muted"
    >
      <span className="sr-only">{t("taskUi.size.prefix")} </span>
      <span>{size}</span>
    </span>
  );
}
