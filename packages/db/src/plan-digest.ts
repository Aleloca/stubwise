import { createHash } from "node:crypto";

/**
 * Digest SHA-256 (esadecimale) del testo di un piano di implementazione.
 *
 * Vive qui — package condiviso da server e worker — perché la pre-approvazione
 * del piano (fase 7) ha bisogno dello STESSO digest su entrambi i lati:
 * `apps/server/src/services/jobs.ts` lo confronta col gate di avvio del run,
 * `POST /api/tickets/:id/pre-approve-plan` lo scrive al momento
 * dell'approvazione. Una funzione pura, non un metodo su un modello: nessuno
 * stato, nessuna dipendenza da Fastify o da Drizzle.
 *
 * ⚠️ Il confronto testuale è VOLUTAMENTE esatto: qualunque riscrittura del
 * piano — via MCP `set_plan`, `PUT /api/tickets/:id/plan` o la riscrittura del
 * worker — produce un digest diverso, e l'approvazione decade da sola perché
 * il gate confronta `plan_approved_digest` col digest del piano CORRENTE. È
 * più robusto che azzerare il campo a ogni scrittura, perché non dipende dal
 * ricordarsi di farlo in ogni percorso che tocca il piano.
 */
export function planDigest(planText: string): string {
  return createHash("sha256").update(planText, "utf8").digest("hex");
}
