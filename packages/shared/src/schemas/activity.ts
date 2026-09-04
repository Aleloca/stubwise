import { z } from "zod";

/**
 * Sottoinsieme MINIMO di `GET /api/activity` (`apps/server/src/routes/
 * activity-routes.ts`) — la Daily Activity Report, feature pre-esistente,
 * NON di questa fase. Non è uno schema condiviso col server (quello resta
 * locale alla rotta: nessuna modifica lì in questa fase): è la forma con cui
 * l'app mobile legge quella risposta per UN solo bisogno, "Report di ieri"
 * nel dettaglio progetto (Fase 4, Task 15) — il riassunto narrativo
 * (`summary`) del report di un progetto per una data.
 *
 * Zod SPOGLIA per default le chiavi non elencate: la risposta vera porta
 * anche `header`, `commits`, `staleCommitCount`, `developers`,
 * `developersSummaryPending`, `staleCommitTotal` — tutte ignorate qui invece
 * che validate, di proposito. Se un giorno servirà altro (i commit del
 * giorno, per esempio) si allarga QUESTO schema, non se ne crea un secondo.
 */
export const activityReportProjectSchema = z.object({
  project: z.object({ id: z.uuid(), name: z.string(), slug: z.string() }),
  status: z.string(),
  summary: z.string().nullable(),
});
export type ActivityReportProject = z.infer<typeof activityReportProjectSchema>;

export const activityForDateSchema = z.object({
  date: z.string(),
  projects: z.array(activityReportProjectSchema),
});
export type ActivityForDate = z.infer<typeof activityForDateSchema>;
