/**
 * I risultati aperti di recente nella ⌘K (shape `search-history.md`): i tipi
 * del server (`searchEntityTypeSchema`), mai la posta (invariante «La posta
 * NON entra nella cronologia della ricerca»).
 */
export const RECENT_TYPES = ["ticket", "project", "repository", "doc"] as const;
export type RecentResultType = (typeof RECENT_TYPES)[number];

/**
 * Lo slug di una pagina Docs da una voce: la nuova app scrive
 * `<repositoryId>:<slug>`, il web vecchio lo slug da solo (con `repositoryId`
 * nella sua colonna). `fromApp` dice chi l'ha scritta.
 */
export function docSlugOf(entityId: string): { slug: string; fromApp: boolean } {
  const at = entityId.indexOf(":");
  return at >= 0 ? { slug: entityId.slice(at + 1), fromApp: true } : { slug: entityId, fromApp: false };
}

/** Una voce come la vede la ⌘K. `code` è il codice da mostrare (sul server: `subtitle`). */
export interface RecentResult {
  type: RecentResultType;
  entityId: string;
  code: string | null;
  title: string;
  /** L'indirizzo nella nuova app (`#/p/…`), ricostruito da tipo e oggetto: si apre di lì. */
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

