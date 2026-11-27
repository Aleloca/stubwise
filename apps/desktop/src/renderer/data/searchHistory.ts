import { gate, now, state, visibleProjectIds } from "./store";
import { writer } from "./writer";
import { canI } from "./admin/common";
import {
  docSlugOf,
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

/**
 * La voce come la vede chi guarda, o null se non la può aprire: il filtro a
 * lettura del server (`historyVisibleSql`) — progetto visibile; una task con
 * `tickets.view_all` o aperta da chi guarda; uno spazio con `docs.view` o
 * `repos.view`; una pagina con `docs.view` (revisione, M1). L'indirizzo si
 * RICOSTRUISCE da tipo e oggetto (I1 a), mai dalla `route` salvata.
 */
function viewOf(me: string, visible: ReadonlySet<string>, e: SearchHistoryEntry): RecentResult | null {
  const base = { type: e.type, entityId: e.entityId, title: e.title, repositoryId: e.repositoryId, openedAt: e.clickedAt };
  const codeOf = (projectId: string) =>
    visible.has(projectId) ? (state.projects.find((p) => p.id === projectId)?.code ?? null) : null;
  switch (e.type) {
    case "project": {
      const code = codeOf(e.entityId);
      return code ? { ...base, code, route: `#/p/${code}/tasks` } : null;
    }
    case "ticket": {
      const task = state.tasks.find((t) => t.id === e.entityId);
      const project = task ? codeOf(task.projectId) : null;
      if (!task || !project) return null;
      if (!canI(me, "tickets.view_all", task.projectId) && task.createdById !== me) return null;
      return { ...base, code: task.code, route: `#/p/${project}/tasks?task=${task.code}` };
    }
    case "repository": {
      const space = state.docSpaces.find((s) => s.repositoryId === e.entityId);
      const project = space ? codeOf(space.projectId) : null;
      if (!space || !project) return null;
      if (!canI(me, "docs.view", space.projectId) && !canI(me, "repos.view", space.projectId)) return null;
      return { ...base, code: null, route: `#/p/${project}/docs/${space.name}` };
    }
    case "doc": {
      const space = state.docSpaces.find((s) => s.repositoryId === e.repositoryId);
      const project = space ? codeOf(space.projectId) : null;
      if (!space || !project || !canI(me, "docs.view", space.projectId)) return null;
      const { slug } = docSlugOf(e.entityId);
      const page = state.docPages.find((p) => p.repositoryId === space.repositoryId && p.slug === slug);
      return page ? { ...base, code: page.code, route: `#/p/${project}/docs/${space.name}/${slug}` } : null;
    }
  }
}

/** I recenti di chi guarda, dal più recente; con `repositoryId` quelli di quello spazio. */
export async function listRecentResults(repositoryId?: string | null): Promise<RecentResult[]> {
  const me = await gate("searchHistory.listRecentResults");
  const visible = visibleProjectIds(me);
  return state.searchHistory
    .filter((e) => e.personId === me && (!repositoryId || e.repositoryId === repositoryId))
    .sort((a, b) => b.clickedAt.localeCompare(a.clickedAt))
    .map((e) => viewOf(me, visible, e))
    .filter((r): r is RecentResult => r !== null)
    .slice(0, RECENT_READ_LIMIT);
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
