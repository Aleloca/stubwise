import type * as Fake from "../../api";
import { isAppRoute, type RecentResult } from "../../searchHistoryModel";
import { appClient } from "./client";

// I risultati aperti di recente nella ⌘K, sulla cronologia del server
// (`/api/search/history`, shape `search-history.md`). Il server filtra già
// per persona e per permessi; qui resta solo ciò che è della nuova app: le
// voci del web vecchio (indirizzi `/tickets/<id>`…) non si mostrano (SR 6), e
// il codice da mostrare viaggia in `subtitle`.

type Live = Partial<typeof Fake.searchHistory>;

export const liveSearchHistory: Live = {
  async listRecentResults(repositoryId) {
    const rows = await appClient().search.history(repositoryId ?? undefined);
    return rows
      .filter((r) => isAppRoute(r.route))
      .map(
        (r): RecentResult => ({
          type: r.type as RecentResult["type"],
          entityId: r.entityId,
          code: r.subtitle,
          title: r.title,
          route: r.route,
          repositoryId: r.repositoryId,
          openedAt: r.clickedAt,
        }),
      );
  },
  async rememberResult(input) {
    await appClient().search.remember({
      type: input.type,
      entityId: input.entityId,
      title: input.title,
      subtitle: input.code,
      route: input.route,
      repositoryId: input.repositoryId,
    });
  },
  async forgetResult(type, entityId) {
    await appClient().search.forget(type, entityId);
  },
  async clearRecentResults() {
    await appClient().search.clearHistory();
  },
};
