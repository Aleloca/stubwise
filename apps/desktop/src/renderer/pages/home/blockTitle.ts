import { useTranslation } from "react-i18next";
import { useSavedFilters } from "../../data/queries";
import type { HomeBlockRef } from "../../data/types";
import { BLOCKS } from "./blocks/registry";

/** La chiave di un blocco: il tipo, più il filtro per i `filter`. */
export const blockKey = (b: HomeBlockRef) =>
  b.kind === "filter" ? `filter:${b.filterId}` : b.kind;

/**
 * Il nome di un blocco a parole (editor, «See what's new»): il titolo del
 * catalogo, o il nome del filtro per un blocco `filter` (finché lo si vede;
 * altrimenti «Saved filter»).
 */
export function useBlockTitle(): (block: HomeBlockRef) => string {
  const { t } = useTranslation();
  const filters = useSavedFilters().data;
  return (block) => {
    if (block.kind === "filter") {
      const filter = filters?.find((f) => f.id === block.filterId);
      if (filter) return filter.name;
    }
    return t(BLOCKS[block.kind].titleKey);
  };
}
