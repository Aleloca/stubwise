import type { MailImportance, MailThreadFilters, MailThreadRow, Project } from "../../data/types";

// I filtri della Posta nell'indirizzo (shape mail.md §3, §9): la casella
// (`mailbox`, un mio indirizzo), l'importanza (`importance`), il progetto
// (`project`: il codice, o `none` = «Senza progetto», A2) e la ricerca
// (`q`). Fonte unica della forma: la usano il router e `data/routes.ts`.

/** Le chiavi proprie della Posta (`project` e `q` sono già dell'app). */
export const MAIL_SEARCH_KEYS = ["mailbox", "importance"] as const;

export const IMPORTANCES = ["high", "normal", "low"] as const satisfies readonly MailImportance[];

/** Il valore di `project` che vuol dire «Senza progetto». */
export const NO_PROJECT = "none";

export interface MailSearch {
  mailbox?: string;
  importance?: string;
  project?: string;
  q?: string;
}

/** `#/mail` e `#/mail/<threadId>`. */
export function isMailPath(path: string): boolean {
  return /^mail(\/[\w-]+)?$/.test(path);
}

/** Un parametro della Posta ha una forma valida (il router scarta il resto). */
export function isMailSearchValue(key: string, value: string): boolean {
  switch (key) {
    case "mailbox":
      return value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value);
    case "importance":
      return (IMPORTANCES as readonly string[]).includes(value);
    case "project":
      return value === NO_PROJECT || /^[A-Z]{2,4}$/.test(value);
    case "q":
      return value.length > 0 && value.length <= 200;
    default:
      return false;
  }
}

/** C'è almeno un filtro dell'elenco (la casella è una vista, non un filtro). */
export const hasFilters = (search: MailSearch): boolean =>
  !!(search.importance || search.project || search.q);

/**
 * I filtri da passare al livello dati. Un codice di progetto che chi guarda
 * non vede (o che non esiste) non filtra per un progetto «altrui»: diventa
 * un filtro che non trova nulla, come per un progetto senza posta.
 */
export function filtersOf(
  search: MailSearch,
  projects: readonly Pick<Project, "id" | "code">[] | undefined,
): { filters: MailThreadFilters; noProject: boolean } {
  const filters: MailThreadFilters = {};
  if (search.mailbox) filters.mailbox = search.mailbox;
  if (search.importance && (IMPORTANCES as readonly string[]).includes(search.importance)) {
    filters.importance = search.importance as MailImportance;
  }
  if (search.q && search.q.trim()) filters.q = search.q.trim();
  const noProject = search.project === NO_PROJECT;
  if (search.project && !noProject) {
    filters.projectId = projects?.find((p) => p.code === search.project)?.id ?? `unknown:${search.project}`;
  }
  return { filters, noProject };
}

/** «Senza progetto»: le conversazioni che non nominano nessun progetto che vedo. */
export const withoutProject = (rows: readonly MailThreadRow[]): MailThreadRow[] =>
  rows.filter((r) => r.projectIds.length === 0);
