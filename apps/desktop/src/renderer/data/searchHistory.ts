import { gate, now, state, visibleProjectIds } from "./store";
import { writer } from "./writer";
import {
  isAppRoute,
  RECENT_KEEP,
  RECENT_READ_LIMIT,
  type RecentResult,
  type RecentResultType,
  type RememberResultInput,
  type SearchHistoryEntry,
} from "./searchHistoryModel";

// I risultati aperti di recente nella ⌘K, nel prototipo (shape
// `search-history.md` §6): le regole del server (`apps/server/src/routes/
// search.ts`) sullo stato finto, per persona. Una voce per oggetto, aggiornata
// a ogni apertura; 8 in lettura, 20 tenute; il filtro dei permessi A LETTURA
// (la riga resta); la posta mai (non è fra i tipi).

/** Il progetto di una voce, per il filtro a lettura; null se l'oggetto non c'è più. */
function projectOf(e: SearchHistoryEntry): string | null {
  switch (e.type) {
    case "project":
      return e.entityId;
    case "ticket":
      return state.tasks.find((t) => t.id === e.entityId)?.projectId ?? null;
    case "repository":
    case "doc":
      return state.repositories.find((r) => r.id === e.repositoryId)?.projectId ?? null;
  }
}

const viewOf = (e: SearchHistoryEntry): RecentResult => ({
  type: e.type,
  entityId: e.entityId,
  code: e.subtitle,
  title: e.title,
  route: e.route,
  repositoryId: e.repositoryId,
  openedAt: e.clickedAt,
});

/** I recenti di chi guarda, dal più recente; con `repositoryId` quelli di quello spazio. */
export async function listRecentResults(repositoryId?: string | null): Promise<RecentResult[]> {
  const me = await gate("searchHistory.listRecentResults");
  const visible = visibleProjectIds(me);
  return state.searchHistory
    .filter((e) => e.personId === me && (!repositoryId || e.repositoryId === repositoryId))
    .filter((e) => {
      const project = projectOf(e);
      return project !== null && visible.has(project);
    })
    .sort((a, b) => b.clickedAt.localeCompare(a.clickedAt))
    .slice(0, RECENT_READ_LIMIT)
    .filter((e) => isAppRoute(e.route))
    .map(viewOf);
}

/** Ricorda un risultato aperto: una voce per oggetto, in cima; poi si tengono le 20 più recenti. */
export async function rememberResult(input: RememberResultInput): Promise<void> {
  const me = await writer("searchHistory.rememberResult");
  const at = now();
  const same = (e: SearchHistoryEntry) => e.personId === me && e.type === input.type && e.entityId === input.entityId;
  state.searchHistory = state.searchHistory.filter((e) => !same(e));
  state.searchHistory.push({
    personId: me,
    type: input.type,
    entityId: input.entityId,
    title: input.title,
    subtitle: input.code,
    route: input.route,
    repositoryId: input.repositoryId,
    clickedAt: at,
  });
  const mine = state.searchHistory
    .filter((e) => e.personId === me)
    .sort((a, b) => b.clickedAt.localeCompare(a.clickedAt));
  const keep = new Set(mine.slice(0, RECENT_KEEP));
  state.searchHistory = state.searchHistory.filter((e) => e.personId !== me || keep.has(e));
}

/** Toglie una voce di chi guarda (idempotente, come il server). */
export async function forgetResult(type: RecentResultType, entityId: string): Promise<void> {
  const me = await writer("searchHistory.forgetResult");
  state.searchHistory = state.searchHistory.filter(
    (e) => !(e.personId === me && e.type === type && e.entityId === entityId),
  );
}

/** Svuota i recenti di chi guarda, anche quelli oltre la lettura. */
export async function clearRecentResults(): Promise<void> {
  const me = await writer("searchHistory.clearRecentResults");
  state.searchHistory = state.searchHistory.filter((e) => e.personId !== me);
}
