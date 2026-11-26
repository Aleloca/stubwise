-- Fix della review della fetta 2 (9 nov 2026): le sistemazioni per giorno
-- valgono per una settimana EFFETTIVA e un assegnatario. Il trigger della
-- 0113 confrontava `planned_week` grezza: riscrivere la settimana corrente di
-- una task slittata (planned_week cambia, la settimana in cui si legge no)
-- cancellava il giorno scelto. Ora confronta la settimana effettiva di prima
-- e di dopo (`stubwise_effective_week`, slittamento e chiusura compresi) e
-- l'assegnatario; scatta anche su `closed_at`, che sposta la settimana
-- effettiva di una task chiusa o riaperta.
CREATE OR REPLACE FUNCTION tickets_reset_day_arrangements() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF stubwise_effective_week(NEW."planned_week", NEW."closed_at")
			IS DISTINCT FROM stubwise_effective_week(OLD."planned_week", OLD."closed_at")
		OR NEW."assignee_id" IS DISTINCT FROM OLD."assignee_id" THEN
		DELETE FROM "task_day_arrangements" WHERE "ticket_id" = NEW."id";
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER "tickets_reset_day_arrangements" ON "tickets";
--> statement-breakpoint
CREATE TRIGGER "tickets_reset_day_arrangements" AFTER UPDATE OF "planned_week", "assignee_id", "closed_at" ON "tickets"
	FOR EACH ROW EXECUTE FUNCTION tickets_reset_day_arrangements();
