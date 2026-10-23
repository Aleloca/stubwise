import { TEMPLATE_STATUSES } from "../../domain/templates";
import type { Project, ProjectStatus, StatusFamily } from "../types";
import { PROJECTS } from "./projects";

/** Gli stati di ogni progetto, quelli iniziali del suo modello. */
export const PROJECT_STATUSES: ProjectStatus[] = PROJECTS.flatMap((p) =>
  TEMPLATE_STATUSES[p.template].map((s, i) => ({
    id: `st-${p.code.toLowerCase()}-${i + 1}`,
    projectId: p.id,
    name: s.name,
    family: s.family,
    order: i,
  })),
);

/**
 * L'`nth` stato (da 0) di una famiglia nel progetto; se la famiglia ne ha
 * meno, l'ultimo. Serve al seed per scegliere «il secondo stato attivo».
 */
export function statusIdOf(project: Project, family: StatusFamily, nth = 0): string {
  const ofFamily = PROJECT_STATUSES.filter(
    (s) => s.projectId === project.id && s.family === family,
  );
  return (ofFamily[nth] ?? ofFamily.at(-1)!).id;
}
