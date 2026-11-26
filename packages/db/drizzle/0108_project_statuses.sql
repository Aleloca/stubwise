-- Integrazione area 2, fetta 1 (9 nov 2026): stati per progetto.
--
-- Lo stato VERO di un ticket è `tickets.status_id`. L'enum `tickets.status`
-- resta come colonna di compatibilità (web vecchio, mobile, MCP, notifiche,
-- pipeline la leggono e la scrivono) e lo tiene coerente il trigger
-- `tickets_status_sync`, in UN posto: nessun codice scrive la mappatura a
-- mano. Regole in docs/invariants/tasks.md.
CREATE TABLE "project_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"family" text NOT NULL,
	"position" integer NOT NULL,
	"legacy_status" "ticket_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_statuses_family_chk" CHECK ("family" IN ('todo', 'active', 'closed')),
	CONSTRAINT "project_statuses_name_chk" CHECK (length(btrim("name")) BETWEEN 1 AND 60),
	-- Differito: riordinare gli stati riscrive le posizioni in più UPDATE.
	CONSTRAINT "project_statuses_project_position_unique" UNIQUE ("project_id", "position") DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE FUNCTION stubwise_legacy_family(s "ticket_status") RETURNS text
LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE s
		WHEN 'open' THEN 'todo'
		WHEN 'triaged' THEN 'todo'
		WHEN 'in_progress' THEN 'active'
		WHEN 'in_review' THEN 'active'
		ELSE 'closed'
	END
$$;
--> statement-breakpoint
-- Lo stato in cui un ticket va quando uno scrittore vecchio ne scrive l'enum.
-- Regola generale: se lo stato corrente ha già quel `legacy_status`, o
-- (todo, in_progress) è già nella famiglia giusta, resta dov'è. Altrimenti:
--   todo        → primo todo
--   in_progress → primo active
--   in_review   → primo active DOPO quello corrente con legacy in_review,
--                 altrimenti l'ultimo active (mai indietro)
--   done        → primo closed con legacy done, altrimenti primo closed
--   closed      → primo closed con legacy closed, altrimenti ultimo closed
CREATE FUNCTION stubwise_status_for_legacy(p_project uuid, p_legacy "ticket_status", p_current uuid) RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
	fam text := stubwise_legacy_family(p_legacy);
	cur "project_statuses"%ROWTYPE;
	result uuid;
BEGIN
	IF p_current IS NOT NULL THEN
		SELECT * INTO cur FROM "project_statuses" WHERE "id" = p_current AND "project_id" = p_project;
	END IF;
	IF cur."id" IS NOT NULL THEN
		IF cur."legacy_status" = p_legacy THEN
			RETURN cur."id";
		END IF;
		IF cur."family" = fam AND p_legacy IN ('open', 'triaged', 'in_progress') THEN
			RETURN cur."id";
		END IF;
	END IF;

	IF fam = 'todo' THEN
		SELECT "id" INTO result FROM "project_statuses"
		WHERE "project_id" = p_project AND "family" = 'todo' ORDER BY "position" LIMIT 1;
	ELSIF p_legacy = 'in_progress' THEN
		SELECT "id" INTO result FROM "project_statuses"
		WHERE "project_id" = p_project AND "family" = 'active' ORDER BY "position" LIMIT 1;
	ELSIF p_legacy = 'in_review' THEN
		SELECT "id" INTO result FROM "project_statuses"
		WHERE "project_id" = p_project AND "family" = 'active' AND "legacy_status" = 'in_review'
			AND "position" > coalesce(cur."position", -1)
		ORDER BY "position" LIMIT 1;
		IF result IS NULL THEN
			SELECT "id" INTO result FROM "project_statuses"
			WHERE "project_id" = p_project AND "family" = 'active' ORDER BY "position" DESC LIMIT 1;
		END IF;
	ELSIF p_legacy = 'done' THEN
		SELECT "id" INTO result FROM "project_statuses"
		WHERE "project_id" = p_project AND "family" = 'closed'
		ORDER BY ("legacy_status" = 'done') DESC, "position" LIMIT 1;
	ELSE
		SELECT "id" INTO result FROM "project_statuses"
		WHERE "project_id" = p_project AND "family" = 'closed' AND "legacy_status" = 'closed'
		ORDER BY "position" LIMIT 1;
		IF result IS NULL THEN
			SELECT "id" INTO result FROM "project_statuses"
			WHERE "project_id" = p_project AND "family" = 'closed' ORDER BY "position" DESC LIMIT 1;
		END IF;
	END IF;
	RETURN result;
END;
$$;
--> statement-breakpoint
-- Gli stati di default (modello «Software» del prototipo). Sono dati, non
-- testi tradotti: si rinominano dalle impostazioni del progetto.
CREATE FUNCTION stubwise_insert_default_statuses(p_project uuid) RETURNS void
LANGUAGE sql AS $$
	INSERT INTO "project_statuses" ("project_id", "name", "family", "position", "legacy_status") VALUES
		(p_project, 'To do', 'todo', 0, 'open'),
		(p_project, 'In progress', 'active', 1, 'in_progress'),
		(p_project, 'In review', 'active', 2, 'in_review'),
		(p_project, 'Done', 'closed', 3, 'done'),
		(p_project, 'Discarded', 'closed', 4, 'closed');
$$;
--> statement-breakpoint
CREATE FUNCTION projects_default_statuses() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM stubwise_insert_default_statuses(NEW."id");
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projects_default_statuses" AFTER INSERT ON "projects"
	FOR EACH ROW EXECUTE FUNCTION projects_default_statuses();
--> statement-breakpoint
SELECT stubwise_insert_default_statuses("id") FROM "projects";
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "status_id" uuid;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "closed_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "tickets" SET "status_id" = stubwise_status_for_legacy("project_id", "status", NULL);
--> statement-breakpoint
-- closed_at: l'ultimo passaggio a done/closed registrato, altrimenti updated_at.
UPDATE "tickets" t SET "closed_at" = coalesce(
	(SELECT max(e."created_at") FROM "ticket_events" e
		WHERE e."ticket_id" = t."id" AND e."kind" = 'status_changed'
			AND e."payload"->>'to' IN ('done', 'closed')),
	t."updated_at"
)
WHERE t."status" IN ('done', 'closed');
--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "status_id" SET NOT NULL;
--> statement-breakpoint
-- NO ACTION (non RESTRICT): uno stato con task non si elimina, ma eliminare
-- il progetto porta via in cascata stati e task nello stesso statement, e il
-- controllo a fine statement lo permette (RESTRICT controllerebbe subito).
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_status_id_fk"
	FOREIGN KEY ("status_id") REFERENCES "project_statuses"("id") ON DELETE NO ACTION;
--> statement-breakpoint
CREATE INDEX "tickets_status_id_idx" ON "tickets" ("status_id");
--> statement-breakpoint
CREATE FUNCTION tickets_status_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	st "project_statuses"%ROWTYPE;
	old_family text;
	status_changed boolean;
	sid_changed boolean;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW."status_id" IS NULL THEN
			NEW."status_id" := stubwise_status_for_legacy(NEW."project_id", NEW."status", NULL);
			SELECT * INTO st FROM "project_statuses" WHERE "id" = NEW."status_id";
		ELSE
			SELECT * INTO st FROM "project_statuses" WHERE "id" = NEW."status_id";
			IF st."id" IS NULL OR st."project_id" <> NEW."project_id" THEN
				RAISE EXCEPTION 'status % non appartiene al progetto %', NEW."status_id", NEW."project_id"
					USING ERRCODE = '23503';
			END IF;
			NEW."status" := st."legacy_status";
		END IF;
		IF st."family" = 'closed' THEN
			NEW."closed_at" := coalesce(NEW."closed_at", now());
		ELSE
			NEW."closed_at" := NULL;
		END IF;
		RETURN NEW;
	END IF;

	status_changed := NEW."status" IS DISTINCT FROM OLD."status";
	sid_changed := NEW."status_id" IS DISTINCT FROM OLD."status_id";

	IF NEW."project_id" IS DISTINCT FROM OLD."project_id" AND NOT sid_changed THEN
		-- Il ticket cambia progetto: lo stato si ricava di nuovo dall'enum.
		NEW."status_id" := stubwise_status_for_legacy(NEW."project_id", NEW."status", NULL);
	ELSIF sid_changed THEN
		SELECT * INTO st FROM "project_statuses" WHERE "id" = NEW."status_id";
		IF st."id" IS NULL OR st."project_id" <> NEW."project_id" THEN
			RAISE EXCEPTION 'status % non appartiene al progetto %', NEW."status_id", NEW."project_id"
				USING ERRCODE = '23503';
		END IF;
		IF status_changed THEN
			IF stubwise_legacy_family(NEW."status") <> st."family" THEN
				RAISE EXCEPTION 'status % e status_id % di famiglie diverse', NEW."status", NEW."status_id"
					USING ERRCODE = '23514';
			END IF;
		ELSE
			NEW."status" := st."legacy_status";
		END IF;
	ELSIF status_changed THEN
		NEW."status_id" := stubwise_status_for_legacy(NEW."project_id", NEW."status", OLD."status_id");
	ELSE
		RETURN NEW;
	END IF;

	SELECT * INTO st FROM "project_statuses" WHERE "id" = NEW."status_id";
	SELECT "family" INTO old_family FROM "project_statuses" WHERE "id" = OLD."status_id";
	IF st."family" = 'closed' THEN
		IF old_family IS DISTINCT FROM 'closed' OR OLD."closed_at" IS NULL THEN
			NEW."closed_at" := now();
		END IF;
	ELSE
		NEW."closed_at" := NULL;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tickets_status_sync" BEFORE INSERT OR UPDATE OF "status", "status_id", "project_id" ON "tickets"
	FOR EACH ROW EXECUTE FUNCTION tickets_status_sync();
