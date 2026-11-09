import type { ProjectEnvironment } from "../../data/model";

// Un server appartiene a un progetto attraverso gli ambienti (R-L2: una
// riga di `servers` per repository o per tutto il progetto). Avvisi del
// catalogo e analisi valgono solo per le PRODUZIONI che lo usano: un server
// solo di staging non avvisa e non si analizza.

/** I progetti la cui produzione usa `serverCode`, una volta ciascuno, nell'ordine degli ambienti. */
export function alertProjectsOf(serverCode: string, envs: ProjectEnvironment[]): string[] {
  const out: string[] = [];
  for (const env of envs) {
    if (env.kind !== "production") continue;
    if (!env.servers.some((s) => s.serverCode === serverCode)) continue;
    if (!out.includes(env.projectId)) out.push(env.projectId);
  }
  return out;
}

/**
 * Il progetto in cui gira l'analisi (e nasce la task): il principale del
 * server se è fra le produzioni che lo usano, altrimenti il primo; `null`
 * senza produzioni, e allora niente analisi (scelta del piano).
 */
export function analysisProjectOf(
  serverCode: string,
  envs: ProjectEnvironment[],
  primaryProjectId: string | null,
): string | null {
  const projects = alertProjectsOf(serverCode, envs);
  if (primaryProjectId !== null && projects.includes(primaryProjectId)) return primaryProjectId;
  return projects[0] ?? null;
}

/**
 * Se `serverCode` è in un ambiente qualunque del progetto (R-L2): la
 * correzione da una task di quel progetto vale solo finché è così.
 */
export const serverInProject = (
  serverCode: string,
  projectId: string,
  envs: ProjectEnvironment[],
): boolean =>
  envs.some((e) => e.projectId === projectId && e.servers.some((s) => s.serverCode === serverCode));
