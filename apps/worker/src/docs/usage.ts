import type { UsageTag } from "../agent/runner.js";

/**
 * Etichetta dei consumi di OGNI run di una generazione Docs (orientamento,
 * brief, esplorazione, sintesi, fase product, design 2026-10-21-modelli-e-
 * consumi): un solo posto, così le fasi non possono divergere. `projectId` è
 * il progetto del repository della generazione (null solo se il repository è
 * sparito nel frattempo). `modelLocked`: il modello lo fissa la generazione
 * all'avvio (`doc_generations.model`), un cambio dalle impostazioni non lo
 * sostituisce a metà. La riga la scrive il TrackingAgentRunner: i costi
 * per-generazione (`doc_generations.cost`, `doc_nodes.cost`) restano dove sono,
 * `agent_runs` si aggiunge.
 */
export function docsGenerationUsage(projectId: string | null): UsageTag {
  return { operation: "docs_generation", projectId, modelLocked: true };
}
