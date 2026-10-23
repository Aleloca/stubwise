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

/** I moduli accesi alla creazione, per modello. */
export const TEMPLATE_MODULES: Record<ProjectTemplate, ProjectModule[]> = {
  software: ["docs", "releases", "support", "servers"],
  marketing: [],
  client: ["docs"],
  empty: [],
};
