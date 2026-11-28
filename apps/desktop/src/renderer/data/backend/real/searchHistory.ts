import type * as Fake from "../../api";
import { RECENT_TYPES, docSlugOf, type RecentResult, type RecentResultType } from "../../searchHistoryModel";
import { appClient } from "./client";

// I risultati aperti di recente nella ⌘K, sulla cronologia del server
// (`/api/search/history`, shape `search-history.md`). Il server filtra già
// per persona e per permessi.
//
// L'indirizzo di una voce si RICOSTRUISCE da tipo e oggetto, mai dalla
// `route` salvata (revisione di feat/ritiro-buchi-minori, I1 a): il web
// vecchio e la nuova app scrivono le stesse righe, e la `route` è quella di
// chi ha aperto per ultimo. Così si aprono anche le voci scritte dal web
// vecchio, e un codice di progetto cambiato non le rende stantie. Una voce
// che non si risolve più (oggetto sparito, spazio che non c'è) non si mostra.

type Live = Partial<typeof Fake.searchHistory>;

const KNOWN = new Set<string>(RECENT_TYPES);

export const liveSearchHistory: Live = {
  async listRecentResults(repositoryId) {
    const client = appClient();
    // I tipi che la nuova app non conosce (un server più nuovo) si scartano (M5).
    const rows = (await client.search.history(repositoryId ?? undefined)).filter((r) => KNOWN.has(r.type));
    if (rows.length === 0) return [];
    const projects = (await client.projects.list()) as unknown as { id: string; slug: string; code?: string }[];
    const codeOf = new Map(projects.map((p) => [p.id, p.code ?? p.slug.toUpperCase()]));
    const needsRepos = rows.some((r) => r.type === "doc" || r.type === "repository");
    const repos = needsRepos ? ((await client.repositories.list()) as { id: string; name: string; projectId: string }[]) : [];
    const repoOf = new Map(repos.map((r) => [r.id, r]));

    const resolved = await Promise.all(
      rows.map(async (r): Promise<RecentResult | null> => {
        const base = { type: r.type as RecentResultType, entityId: r.entityId, title: r.title, repositoryId: r.repositoryId, openedAt: r.clickedAt };
        switch (r.type) {
          case "project": {
            const code = codeOf.get(r.entityId);
            return code ? { ...base, code, route: `#/p/${code}/tasks` } : null;
          }
          case "ticket": {
            const ticket = await client.tickets.get(r.entityId).catch(() => null);
            const project = ticket ? codeOf.get(ticket.projectId) : undefined;
            if (!ticket || !project) return null;
            const code = `${project}-${ticket.number}`;
            return { ...base, code, route: `#/p/${project}/tasks?task=${code}` };
          }
          case "repository": {
            const repo = repoOf.get(r.entityId);
            const project = repo ? codeOf.get(repo.projectId) : undefined;
            return repo && project ? { ...base, code: null, route: `#/p/${project}/docs/${repo.name}` } : null;
          }
          case "doc": {
            const repo = r.repositoryId ? repoOf.get(r.repositoryId) : undefined;
            const project = repo ? codeOf.get(repo.projectId) : undefined;
            if (!repo || !project) return null;
            const { slug, fromApp } = docSlugOf(r.entityId);
            // Il codice della pagina (`AUD-D12`) l'ha scritto solo la nuova app, in `subtitle`.
            return { ...base, code: fromApp ? r.subtitle : null, route: `#/p/${project}/docs/${repo.name}/${slug}` };
          }
          default:
            return null;
        }
      }),
    );
    return resolved.filter((r): r is RecentResult => r !== null);
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
