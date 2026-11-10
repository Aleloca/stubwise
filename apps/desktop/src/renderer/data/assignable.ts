import type { Person, Project } from "./types";

/**
 * Chi si può assegnare a una task di un progetto: i suoi membri e, nella build
 * app, Claude dove la sua riga di `/api/people` lo dice (integrazione area 3,
 * 3e.2). Sul server Claude non è membro di nessun progetto: dove chi guarda
 * può avviarne il lavoro (`runs.start`) il server elenca il progetto in
 * `claudeAssignableProjectIds`, e la regola resta del server (un 403
 * `claude_assign_forbidden` se cambia nel frattempo). Nel prototipo Claude è
 * nei `memberIds` e `assignableProjectIds` è assente: vale l'appartenenza.
 */
export function isAssignableIn(person: Person, project: Pick<Project, "id" | "memberIds"> | undefined): boolean {
  if (!project) return false;
  if (project.memberIds.includes(person.id)) return true;
  return person.isClaude && !!person.assignableProjectIds?.includes(project.id);
}

/** Gli id assegnabili in un progetto (`memberIds` più Claude dove si assegna). */
export function assignableIn(project: Pick<Project, "id" | "memberIds"> | undefined, people: readonly Person[]): string[] {
  if (!project) return [];
  const claude = people.filter((p) => p.isClaude && !project.memberIds.includes(p.id) && isAssignableIn(p, project));
  return [...project.memberIds, ...claude.map((p) => p.id)];
}
