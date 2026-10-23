import type { SavedFilter } from "../types";

const OPEN = ["todo", "active"] as const;

/**
 * Filtri salvati: cinque pubblici (nomi: dati inglesi del seed) di autori
 * diversi — anche di chi vede più progetti degli altri — e due privati di
 * Giulia. Un filtro pubblico mostra a ognuno solo le task che può vedere.
 */
export const SAVED_FILTERS: SavedFilter[] = [
  {
    id: "flt-open",
    name: "Open",
    ownerId: "p-roberta",
    visibility: "public",
    criteria: { families: [...OPEN] },
    view: "list",
    groupBy: "status",
  },
  {
    id: "flt-closed-month",
    name: "Closed this month",
    ownerId: "p-laura",
    visibility: "public",
    criteria: {
      families: ["closed"],
      period: { field: "closed", kind: "relative", preset: "thisMonth" },
    },
    view: "list",
    groupBy: "none",
  },
  {
    id: "flt-stalled",
    name: "Stalled for more than 7 days",
    ownerId: "p-laura",
    visibility: "public",
    // `FilterCriteria` dice solo «ferma sì/no»: la soglia dei 7 giorni è
    // quella di default dei progetti, il nome la rende esplicita.
    criteria: { stalled: true },
    view: "list",
    groupBy: "assignee",
  },
  {
    id: "flt-no-estimate",
    name: "No estimate",
    ownerId: "p-giulia",
    visibility: "public",
    criteria: { families: [...OPEN], sizes: ["none"] },
    view: "list",
    groupBy: "none",
  },
  {
    id: "flt-unassigned",
    name: "Unassigned",
    ownerId: "p-marco",
    visibility: "public",
    criteria: { families: [...OPEN], assigneeIds: ["none"] },
    view: "board",
    groupBy: "status",
  },
  {
    id: "flt-giulia-week",
    name: "Marketing this week",
    ownerId: "p-giulia",
    visibility: "private",
    criteria: {
      departmentIds: ["dep-marketing"],
      families: [...OPEN],
      period: { field: "plannedWeek", kind: "relative", preset: "thisWeek" },
    },
    view: "list",
    groupBy: "assignee",
  },
  {
    id: "flt-giulia-mkx",
    name: "Mix Cucine, waiting",
    ownerId: "p-giulia",
    visibility: "private",
    criteria: { projectIds: ["prj-mkx"], stalled: true },
    view: "board",
    groupBy: "status",
  },
];

/**
 * Filtri fissati nella colonna della Home, per persona (nell'ordine in cui
 * sono stati fissati): Giulia ne ha uno privato e uno pubblico, così la
 * colonna li mostra fin dall'apertura. Gli altri non ne hanno.
 */
export const INITIAL_PINNED_FILTERS: Record<string, string[]> = {
  "p-giulia": ["flt-giulia-week", "flt-no-estimate"],
};
