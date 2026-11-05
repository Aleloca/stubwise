import type { ProjectModule, ProjectTemplate, StatusFamily } from "../data/model";

/** Gli stati iniziali di un progetto per modello (nomi: dati inglesi del seed). */
export const TEMPLATE_STATUSES: Record<ProjectTemplate, { name: string; family: StatusFamily }[]> =
  {
    software: [
      { name: "To do", family: "todo" },
      { name: "In progress", family: "active" },
      { name: "In review", family: "active" },
      { name: "Done", family: "closed" },
      { name: "Dropped", family: "closed" },
    ],
    marketing: [
      { name: "Idea", family: "todo" },
      { name: "Draft", family: "active" },
      { name: "In approval", family: "active" },
      { name: "Published", family: "closed" },
      { name: "Dropped", family: "closed" },
    ],
    client: [
      { name: "To do", family: "todo" },
      { name: "In progress", family: "active" },
      { name: "Waiting on client", family: "active" },
      { name: "Delivered", family: "closed" },
      { name: "Dropped", family: "closed" },
    ],
    empty: [
      { name: "To do", family: "todo" },
      { name: "In progress", family: "active" },
      { name: "Done", family: "closed" },
    ],
  };

/**
 * Il posto di ogni modulo nell'elenco di un progetto. Un `Record` su tutta
 * l'unione: un modulo nuovo senza il suo posto non compila.
 */
const MODULE_RANK: Record<ProjectModule, number> = {
  docs: 0,
  releases: 1,
  support: 2,
  servers: 3,
};

/** I moduli nell'ordine in cui un progetto li elenca (quello di `TEMPLATE_MODULES`). */
export const MODULE_ORDER: readonly ProjectModule[] = (
  Object.keys(MODULE_RANK) as ProjectModule[]
).sort((a, b) => MODULE_RANK[a] - MODULE_RANK[b]);

/** I moduli accesi alla creazione, per modello. */
export const TEMPLATE_MODULES: Record<ProjectTemplate, ProjectModule[]> = {
  software: ["docs", "releases", "support", "servers"],
  marketing: [],
  client: ["docs"],
  empty: [],
};
