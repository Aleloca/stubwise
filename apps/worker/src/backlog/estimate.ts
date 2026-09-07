import { backlogItems } from "@stubwise/db";
import {
  backlogRiskSchema,
  backlogUrgencySchema,
  effortSchema,
  type BacklogEstimatePayload,
} from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { outputOrThrow, parseAgentJson } from "../agent/text.js";
import { loadProjectAiProviderId, resolveBacklogProvider } from "./provider.js";
import { buildEstimatePrompt } from "./prompts.js";
import type { BacklogDeps, BacklogJob } from "./poller.js";

/**
 * ESTIMATE del backlog di discovery: stima i SOLI metadati di una voce nata
 * "from-design" (documento = design verbatim, effort/risk/urgency/embedding NULL).
 *
 * A DIFFERENZA dell'intake — che GENERA titolo, documento e stime da un feedback
 * grezzo — l'estimate parte da un documento GIÀ PRONTO: NON lo riscrive e NON ne
 * cambia il titolo. Legge il documento, ne calcola l'embedding (per il dedup
 * semantico successivo) e stima effort/risk/urgency, scrivendoli nei campi
 * DIRETTI (non in `suggested`: la voce nasce senza stime, questi sono i valori di
 * partenza — stesso principio dell'intake).
 *
 * ERRORI: voce inesistente → no-op (done, ritentare è inutile). Voce già chiusa
 * (`converted`/`archived`) → no-op (stimare una voce chiusa non serve). Tutto il
 * resto (embedding, agente, parse) → throw: il poller riaccoda finché ci sono
 * tentativi, poi failed.
 */

/** Output JSON della stima (buildEstimatePrompt): SOLO i metadati, nessun
 * titolo/documento (esistono già e non vanno toccati). Schema violato → parse
 * null → throw → retry. */
const estimateOutputSchema = z.object({
  effort: effortSchema,
  risk: backlogRiskSchema,
  riskNote: z.string().max(2000).optional(),
  urgency: backlogUrgencySchema,
});
type EstimateOutput = z.infer<typeof estimateOutputSchema>;

/**
 * Esegue l'estimate di un job del backlog (già reclamato). Vedi il commento di
 * modulo per il contratto di errori. NON tocca `document` né `title`: scrive solo
 * effort/risk/riskNote/urgency + embedding.
 */
export async function runEstimate(
  deps: BacklogDeps,
  job: BacklogJob,
  payload: BacklogEstimatePayload,
): Promise<void> {
  const { db } = deps;

  // 1. Voce: inesistente o già chiusa (converted/archived) → no-op (ritentare
  //    non cambia nulla; una voce chiusa non va stimata).
  const [item] = await db
    .select({ document: backlogItems.document, status: backlogItems.status })
    .from(backlogItems)
    .where(eq(backlogItems.id, payload.itemId));
  if (!item || item.status === "converted" || item.status === "archived") {
    deps.logger.warn(
      { jobId: job.id, itemId: payload.itemId },
      "[backlog] estimate: voce inesistente o già chiusa, no-op",
    );
    return;
  }

  // 2. Embedding del documento (per il dedup semantico). Un fallimento lancia → retry.
  const [vec] = await deps.embeddingClient.embed([item.document]);
  if (!vec) throw new Error("estimate: embedding, nessun vettore restituito");

  // 3. Provider AI del run (pinned del progetto o chain[0]); undefined = auth del
  //    container. Risolto una volta per job.
  const aiProviderId = await loadProjectAiProviderId(db, job.projectId);
  const provider = await resolveBacklogProvider(deps, aiProviderId);

  // 4. Run dell'agente (senza tool, come l'intake): stima i soli metadati dal
  //    documento già pronto.
  const result = await deps.runner.run({
    cwd: deps.workDir,
    prompt: buildEstimatePrompt(item.document),
    ...(deps.model !== undefined ? { model: deps.model } : {}),
    permissionMode: "default",
    maxTurns: 3,
    timeoutMs: deps.agentTimeoutMs,
    ...(provider !== undefined ? { provider } : {}),
  });

  // 5. Parse difensivo: exit ≠ 0 o output non conforme → throw (retry).
  const parsed: EstimateOutput | null = parseAgentJson(estimateOutputSchema, outputOrThrow(result, "estimate"));
  if (!parsed) throw new Error("estimate: output dell'agente non parsabile");

  // 6. Scrive SOLO i metadati diretti + embedding; document e title INVARIATI.
  await db
    .update(backlogItems)
    .set({
      effort: parsed.effort,
      risk: parsed.risk,
      riskNote: parsed.riskNote ?? null,
      urgency: parsed.urgency,
      embedding: vec,
    })
    .where(eq(backlogItems.id, payload.itemId));
}
