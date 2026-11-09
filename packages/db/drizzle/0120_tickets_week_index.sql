-- Fix della review della fetta 2 (9 nov 2026): l'indice della 0113 era
-- parziale sulle task aperte e i filtri passavano tutti dalla funzione
-- `stubwise_effective_week`, quindi non lo usava nessuno. I filtri ora sono
-- in forma sargable (su `planned_week` nuda per le aperte, la funzione solo
-- per le chiuse: `effectiveWeekIs`/`effectiveWeekOverlaps` del server), e
-- l'indice copre tutte le task, così anche il ramo delle chiuse ha
-- l'assegnatario come accesso.
DROP INDEX "tickets_assignee_planned_week_idx";
--> statement-breakpoint
CREATE INDEX "tickets_assignee_planned_week_idx" ON "tickets" ("assignee_id", "planned_week");
