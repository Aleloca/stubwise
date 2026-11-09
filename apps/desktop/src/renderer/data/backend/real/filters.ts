import { ApiError } from "@stubwise/api-client";
import { parseCriteria, type SavedFilterView } from "@stubwise/shared";
import type * as Fake from "../../api";
import type { SavedFilter } from "../../types";
import { appClient } from "./client";

// I filtri salvati della build app (integrazione area 2, fetta 3): i miei e i
// pubblici, dal server. I criteri arrivano larghi e si normalizzano con
// `parseCriteria` (un criterio che questa app non conosce si scarta); chi può
// modificare ed eliminare lo dice il server (`canEdit`), il client lo legge.
// Le task di un filtro si leggono con `listTasks(criteria)`: un filtro
// pubblico mostra a ciascuno solo le task che vede già.

export function toFilter(view: SavedFilterView): SavedFilter {
  return {
    id: view.id,
    name: view.name,
    ownerId: view.ownerId,
    visibility: view.visibility,
    criteria: parseCriteria(view.criteria) ?? {},
    view: view.view,
    groupBy: view.groupBy,
    canEdit: view.canEdit,
  } as SavedFilter;
}

export const listSavedFilters: typeof Fake.listSavedFilters = async () =>
  (await appClient().filters.list()).map((v) => toFilter(v as SavedFilterView));

/** Un filtro che non vedo (privato d'altri, o eliminato) risponde come uno che non c'è: `null`. */
export const getSavedFilter: typeof Fake.getSavedFilter = async (id) => {
  try {
    return toFilter((await appClient().filters.get(id)) as SavedFilterView);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
};

export const listPinnedFilterIds: typeof Fake.listPinnedFilterIds = () => appClient().filters.pinned();

export const saveFilter: typeof Fake.saveFilter = async (input) =>
  toFilter(
    (await appClient().filters.create({
      name: input.name,
      visibility: input.visibility,
      criteria: input.criteria,
      view: input.view,
      groupBy: input.groupBy,
    } as never)) as SavedFilterView,
  );

export const updateFilter: typeof Fake.updateFilter = async (id, patch) =>
  toFilter((await appClient().filters.update(id, patch as never)) as SavedFilterView);

/** Lo toglie anche dai fissati di tutti; nelle Home resta un blocco «non disponibile». */
export const deleteFilter: typeof Fake.deleteFilter = (id) => appClient().filters.remove(id);

export const setFilterPinned: typeof Fake.setFilterPinned = (filterId, pinned) =>
  pinned ? appClient().filters.pin(filterId) : appClient().filters.unpin(filterId);
