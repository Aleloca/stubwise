import { environmentServers, projectEnvironments, serverMetrics, type Db } from "@stubwise/db";
import type { DiscoveredService } from "@stubwise/shared";
import { and, desc, eq } from "drizzle-orm";
import type { DbOrTx } from "./dispatch.js";

/**
 * L'AMBIENTE DI PRODUZIONE DI UNA REPOSITORY (area 8, F1): il server su cui
 * gira la repository nell'ambiente di produzione del progetto
 * (`environment_servers`, R-L2) e l'ultimo campione che il suo agente ha
 * mandato. Lo leggono il worker (il poller dei rilasci: «il commit è in
 * produzione?») e il server (lo stato derivato nelle rotte): una lettura sola,
 * perché due copie direbbero due stati diversi dello stesso rilascio.
 */
export interface ReleaseProduction {
  /** C'è un ambiente di produzione nel progetto. */
  environment: boolean;
  /** Il server della repository in produzione, se c'è. */
  serverId: string | null;
  /** I servizi dell'ultimo campione dell'agente (vuoti senza server o senza campioni). */
  services: DiscoveredService[];
  /** Il primo commit che un servizio riporta, e quando è arrivato il campione. */
  reportedSha: string | null;
  reportedAt: string | null;
}

export async function releaseProductionOf(db: DbOrTx, projectId: string, repositoryId: string): Promise<ReleaseProduction> {
  const none = { serverId: null, services: [], reportedSha: null, reportedAt: null };
  const [env] = await (db as Db)
    .select({ id: projectEnvironments.id, serverId: projectEnvironments.serverId })
    .from(projectEnvironments)
    .where(and(eq(projectEnvironments.projectId, projectId), eq(projectEnvironments.kind, "production")));
  if (!env) return { environment: false, ...none };
  const [link] = await (db as Db)
    .select({ serverId: environmentServers.serverId })
    .from(environmentServers)
    .where(and(eq(environmentServers.environmentId, env.id), eq(environmentServers.repositoryId, repositoryId)));
  // Senza una riga per QUESTA repository (aggiunta dopo la scrittura) vale il
  // server dell'ambiente, la forma di prima (review F1).
  const serverId = link?.serverId ?? env.serverId;
  if (!serverId) return { environment: true, ...none };
  const [sample] = await (db as Db)
    .select({ services: serverMetrics.services, ts: serverMetrics.ts })
    .from(serverMetrics)
    .where(eq(serverMetrics.serverId, serverId))
    .orderBy(desc(serverMetrics.ts))
    .limit(1);
  const services = (sample?.services ?? []) as DiscoveredService[];
  return {
    environment: true,
    serverId,
    services,
    reportedSha: services.find((s) => s.commitSha)?.commitSha ?? null,
    reportedAt: sample?.ts.toISOString() ?? null,
  };
}

/** L'ingresso `production` di `releaseStatusOf` (shared) da {@link ReleaseProduction}. */
export function productionForStatus(p: ReleaseProduction): { hasServers: boolean; server: { reportedSha: string | null; reportedAt: string | null } | null } | null {
  if (!p.environment) return null;
  return { hasServers: p.serverId !== null, server: p.serverId ? { reportedSha: p.reportedSha, reportedAt: p.reportedAt } : null };
}
