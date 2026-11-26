import { eq } from "drizzle-orm";
import { environmentServers, projectEnvironments, projects, type Db } from "@stubwise/db";
import type { AttributionInput } from "@stubwise/shared";
import { seenContainers } from "./commands.js";

/**
 * Area 8, F4b (S5b/S6): i progetti i cui ambienti usano un server, coi
 * container di ciascun ambiente su QUEL server, più i container che l'agente
 * vede. Lo leggono l'attribuzione (worker), la validazione del piano
 * all'approvazione (server) e i ricontrolli prima di ogni passo (worker).
 */
export async function attributionContext(db: Db, serverId: string): Promise<Omit<AttributionInput, "cause">> {
  const rows = await db
    .select({
      projectId: projects.id,
      projectCode: projects.code,
      envName: projectEnvironments.name,
      containers: environmentServers.containers,
    })
    .from(environmentServers)
    .innerJoin(projectEnvironments, eq(projectEnvironments.id, environmentServers.environmentId))
    .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
    .where(eq(environmentServers.serverId, serverId));
  const byProject = new Map<string, { projectId: string; projectCode: string; environments: Map<string, Set<string>> }>();
  for (const r of rows) {
    const p = byProject.get(r.projectId) ?? { projectId: r.projectId, projectCode: r.projectCode, environments: new Map() };
    const env = p.environments.get(r.envName) ?? new Set<string>();
    for (const c of r.containers) env.add(c);
    p.environments.set(r.envName, env);
    byProject.set(r.projectId, p);
  }
  return {
    serverProjects: [...byProject.values()].map((p) => ({
      projectId: p.projectId,
      projectCode: p.projectCode,
      environments: [...p.environments].map(([name, cs]) => ({ name, containers: [...cs] })),
    })),
    seenContainers: await seenContainers(db, serverId),
  };
}

