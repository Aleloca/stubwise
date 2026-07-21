import { projects, type Db } from "@stubwise/db";
import { eq } from "drizzle-orm";
import {
  loadProviderById,
  loadProviderChain,
  type ResolvedProvider,
} from "../providers/chain.js";
import type { BacklogDeps } from "./poller.js";

/**
 * Risoluzione del provider AI per i run del backlog (intake e deep dive), in un
 * modulo a sé per NON creare un ciclo di import a livello di valore fra
 * poller.ts (importa runDeepDive) e i moduli che eseguono i run.
 */

/**
 * Risolve il provider AI del progetto per i run del backlog: pinned del progetto
 * (SOLO quello, niente fallback) oppure chain[0] globale. Ritorna undefined se
 * nulla è utilizzabile (pinned non risolvibile o catena vuota): in quel caso il
 * run gira con l'auth di default del container (comportamento storico dell'intake,
 * che prima non passava alcun provider). Stesso contratto del daily-report (best
 * effort), NON quello della review (che invece fallisce sul pinned mancante).
 */
export async function resolveBacklogProvider(
  deps: Pick<BacklogDeps, "db" | "encryptionKey" | "loadProviderByIdFn" | "loadProviderChainFn">,
  aiProviderId: string | null,
): Promise<ResolvedProvider | undefined> {
  if (aiProviderId) {
    const loadById = deps.loadProviderByIdFn ?? loadProviderById;
    return (await loadById(deps.db, deps.encryptionKey, aiProviderId)) ?? undefined;
  }
  const loadChain = deps.loadProviderChainFn ?? loadProviderChain;
  const chain = await loadChain(deps.db, deps.encryptionKey);
  return chain[0];
}

/** Provider AI pinned del progetto (null se assente): l'aiProviderId da passare a
 * {@link resolveBacklogProvider}. Progetto sparito → null (fallback a chain[0]). */
export async function loadProjectAiProviderId(db: Db, projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ aiProviderId: projects.aiProviderId })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row?.aiProviderId ?? null;
}
