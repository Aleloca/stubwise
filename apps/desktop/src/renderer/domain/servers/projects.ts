import type { AttributionInput } from "@stubwise/shared";
import type { ProjectEnvironment } from "../../data/model";

// Un server appartiene a un progetto attraverso gli ambienti (R-L2: una
// riga di `servers` per repository o per tutto il progetto). Gli avvisi del
// catalogo vanno solo alle PRODUZIONI che lo usano: un server solo di staging
// non avvisa e non si analizza. L'analisi è del SERVER (area 8, F4b-4):
// nessun progetto scelto prima; è lei a dire quale progetto è la causa, e
// l'attribuzione si valida contro TUTTI i progetti del server.

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
 * I progetti i cui ambienti (di ogni tipo) usano `serverCode`, nella forma
 * di `attributeServerCause` di `@stubwise/shared` (area 8, F4b-4): l'analisi
 * parte dal SERVER e l'attribuzione al progetto si valida contro questi.
 * Un progetto una volta sola, nell'ordine degli ambienti. I container sono
 * quelli dell'ambiente su QUESTO server (R0-D, R7); senza, vale il container
 * col NOME dell'ambiente (la regola di shared).
 */
export function serverProjectsOf(
  serverCode: string,
  envs: ProjectEnvironment[],
  codeOf: (projectId: string) => string,
): AttributionInput["serverProjects"] {
  const out: {
    projectId: string;
    projectCode: string;
    environments: { name: string; containers: string[] }[];
  }[] = [];
  for (const env of envs) {
    if (!env.servers.some((s) => s.serverCode === serverCode)) continue;
    let p = out.find((x) => x.projectId === env.projectId);
    if (!p) {
      p = { projectId: env.projectId, projectCode: codeOf(env.projectId), environments: [] };
      out.push(p);
    }
    // I container di QUESTO server nell'ambiente (R0-D), su ogni sua riga.
    const containers = [
      ...new Set(
        env.servers.flatMap((s) => (s.serverCode === serverCode ? (s.containers ?? []) : [])),
      ),
    ];
    p.environments.push({ name: env.name, containers });
  }
  return out;
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
