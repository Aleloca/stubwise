import { z } from "zod";

/**
 * Il grafo del codice di un repository (graphify): le forme delle rotte
 * `/api/repositories/:id/graph…`. Erano scritte solo nella rotta
 * (`apps/server/src/routes/repo-graph.ts`); il desktop le legge ora dall'api-
 * client (area 5, fetta 1): spostate qui SENZA cambiarne la forma.
 */

/**
 * Stato del grafo di un repository per la UI. `status`/`error` descrivono la
 * BUILD (riga `repo_graphs`); `setupPrJobPending`/`setupPrError` descrivono la PR
 * di setup, che ha un ciclo di vita indipendente: un setup_pr fallito NON tocca
 * `repo_graphs` (il grafo resta `done`), perciò il suo errore ha un campo suo.
 */
export const repoGraphStateSchema = z.object({
  /** Toggle `repositories.graph_enabled`: senza, nulla viene generato ai push. */
  enabled: z.boolean(),
  status: z.enum(["none", "queued", "running", "done", "failed"]),
  commitSha: z.string().nullable(),
  nodeCount: z.int().nullable(),
  edgeCount: z.int().nullable(),
  communityCount: z.int().nullable(),
  labeled: z.boolean(),
  generatedAt: z.iso.datetime().nullable(),
  setupPrUrl: z.string().nullable(),
  error: z.string().nullable(),
  /** Esiste un job `build` queued/running (la UI fa polling finché è true). */
  jobPending: z.boolean(),
  /** Esiste un job `setup_pr` queued/running. */
  setupPrJobPending: z.boolean(),
  /** Errore dell'ULTIMO job `setup_pr`, se è fallito; null se l'ultimo è andato a buon fine. */
  setupPrError: z.string().nullable(),
});
export type RepoGraphState = z.infer<typeof repoGraphStateSchema>;

/** `POST …/graph/generate`: `force` passa `--force` a graphify (rifà da zero). */
export const repoGraphGenerateBodySchema = z.object({
  force: z.boolean().optional(),
});
export type RepoGraphGenerateInput = z.input<typeof repoGraphGenerateBodySchema>;

/** La risposta 202 di `generate` e `setup-pr`: il job è in coda. */
export const repoGraphQueuedSchema = z.object({ queued: z.literal(true) });
