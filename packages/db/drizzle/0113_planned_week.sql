-- Integrazione area 2, fetta 2 (9 nov 2026): la settimana pianificata, lo
-- slittamento DERIVATO a lettura e le sistemazioni per giorno.
--
-- `planned_week` è il LUNEDÌ della settimana scelta da una persona; sul filo
-- diventa `YYYY-Www` (`@stubwise/shared`, `tasks/weeks.ts`). Lo slittamento
-- non lo scrive nessun job: una task aperta con la settimana passata si LEGGE
-- nella settimana corrente (`stubwise_effective_week`), e le settimane
-- trascorse si sommano a `slip_count` (`stubwise_slip_weeks`). Il trigger
-- `tickets_consolidate_slip` consolida il derivato in `slip_count` quando una
-- scrittura cambia `planned_week`, così il conteggio non si perde né si
-- raddoppia. Regole in docs/invariants/tasks.md.
ALTER TABLE "tickets" ADD COLUMN "planned_week" date;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "slip_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_planned_week_monday_chk"
	CHECK ("planned_week" IS NULL OR extract(isodow from "planned_week") = 1);
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_slip_count_chk" CHECK ("slip_count" >= 0);
--> statement-breakpoint
CREATE INDEX "tickets_assignee_planned_week_idx" ON "tickets" ("assignee_id", "planned_week")
	WHERE "closed_at" IS NULL;
--> statement-breakpoint
-- Il lunedì della settimana corrente, nel fuso Europe/Rome (quello del giro
-- notturno; il gemello TS è `currentIsoWeek`). `stubwise.today` (data ISO),
-- se impostato nella transazione, lo sostituisce: serve ai test.
CREATE FUNCTION stubwise_current_monday() RETURNS date
LANGUAGE sql STABLE AS $$
	SELECT date_trunc('week', coalesce(
		nullif(current_setting('stubwise.today', true), '')::timestamp,
		now() AT TIME ZONE 'Europe/Rome'
	))::date
$$;
--> statement-breakpoint
-- Fin dove scivola una task: alla settimana corrente se è aperta, alla
-- settimana in cui è stata chiusa se è chiusa (il conteggio si ferma lì).
CREATE FUNCTION stubwise_slip_reference(closed_at timestamptz) RETURNS date
LANGUAGE sql STABLE AS $$
	SELECT CASE
		WHEN closed_at IS NULL THEN stubwise_current_monday()
		ELSE date_trunc('week', closed_at AT TIME ZONE 'Europe/Rome')::date
	END
$$;
--> statement-breakpoint
CREATE FUNCTION stubwise_effective_week(planned date, closed_at timestamptz) RETURNS date
LANGUAGE sql STABLE AS $$
	SELECT CASE WHEN planned IS NULL THEN NULL ELSE greatest(planned, stubwise_slip_reference(closed_at)) END
$$;
--> statement-breakpoint
CREATE FUNCTION stubwise_slip_weeks(planned date, closed_at timestamptz) RETURNS integer
LANGUAGE sql STABLE AS $$
	SELECT CASE
		WHEN planned IS NULL THEN 0
		ELSE greatest(0, (stubwise_slip_reference(closed_at) - planned) / 7)
	END
$$;
--> statement-breakpoint
CREATE FUNCTION tickets_consolidate_slip() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."planned_week" IS DISTINCT FROM OLD."planned_week" THEN
		NEW."slip_count" := OLD."slip_count" + stubwise_slip_weeks(OLD."planned_week", OLD."closed_at");
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tickets_consolidate_slip" BEFORE UPDATE OF "planned_week" ON "tickets"
	FOR EACH ROW EXECUTE FUNCTION tickets_consolidate_slip();
--> statement-breakpoint
-- Il giorno in cui l'assegnatario si mette una task: PERSONALE (lo legge e
-- lo scrive solo l'assegnatario, regola nel servizio), e vale per quella
-- settimana e quell'assegnatario.
CREATE TABLE "task_day_arrangements" (
	"ticket_id" uuid NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"week" date NOT NULL,
	"day" smallint,
	CONSTRAINT "task_day_arrangements_pk" PRIMARY KEY ("ticket_id", "user_id", "week"),
	CONSTRAINT "task_day_arrangements_week_monday_chk" CHECK (extract(isodow from "week") = 1),
	CONSTRAINT "task_day_arrangements_day_chk" CHECK ("day" IS NULL OR "day" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE INDEX "task_day_arrangements_user_week_idx" ON "task_day_arrangements" ("user_id", "week");
--> statement-breakpoint
-- Da QUALUNQUE scrittura: cambiano davvero settimana o assegnatario → le
-- sistemazioni della task non valgono più.
CREATE FUNCTION tickets_reset_day_arrangements() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."planned_week" IS DISTINCT FROM OLD."planned_week"
		OR NEW."assignee_id" IS DISTINCT FROM OLD."assignee_id" THEN
		DELETE FROM "task_day_arrangements" WHERE "ticket_id" = NEW."id";
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tickets_reset_day_arrangements" AFTER UPDATE OF "planned_week", "assignee_id" ON "tickets"
	FOR EACH ROW EXECUTE FUNCTION tickets_reset_day_arrangements();
