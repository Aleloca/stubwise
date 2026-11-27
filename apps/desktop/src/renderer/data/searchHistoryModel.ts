/**
 * I risultati aperti di recente nella ⌘K (shape `search-history.md`): i tipi
 * del server (`searchEntityTypeSchema`), mai la posta (invariante «La posta
 * NON entra nella cronologia della ricerca»).
 */
export type RecentResultType = "ticket" | "project" | "repository" | "doc";

/** Una voce come la vede la ⌘K. `code` è il codice da mostrare (sul server: `subtitle`). */
export interface RecentResult {
  type: RecentResultType;
  entityId: string;
  code: string | null;
  title: string;
  /** L'indirizzo nella nuova app (`#/p/…`): si apre di lì. */
  route: string;
  repositoryId: string | null;
  openedAt: string;
}

/** Ciò che la ⌘K registra all'apertura di un risultato. */
export interface RememberResultInput {
  type: RecentResultType;
  entityId: string;
  code: string | null;
  title: string;
  route: string;
  repositoryId: string | null;
}

/** La riga dello stato finto (per persona). */
export interface SearchHistoryEntry {
  personId: string;
  type: RecentResultType;
  entityId: string;
  title: string;
  subtitle: string | null;
  route: string;
  repositoryId: string | null;
  clickedAt: string;
}

/** Quante voci dà la lettura (come `HISTORY_LIMIT` del server) e quante se ne tengono (`HISTORY_KEEP`). */
export const RECENT_READ_LIMIT = 8;
export const RECENT_KEEP = 20;

/** Una voce registrata dal web vecchio (`/tickets/<id>`…) non si apre nella nuova app: non si mostra (SR 6). */
export const isAppRoute = (route: string): boolean => route.startsWith("#/");
