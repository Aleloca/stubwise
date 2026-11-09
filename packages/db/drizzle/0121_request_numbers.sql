-- Integrazione area 2, fetta 4 (10 nov 2026): il numero di catalogo delle
-- richieste (`<PROGETTO>-R<n>`). Un contatore per progetto, dato dal trigger
-- a OGNI voce nuova — anche a quelle che l'intake del worker crea —, mai
-- riusato (un numero eliminato non torna). Le voci di prima sono numerate
-- per data di creazione (e id), fuse e archiviate comprese: sono gli stessi
-- numeri che `/api/requests/to-convert` ricavava a lettura (fetta 3), così i
-- codici già mostrati non cambiano.
ALTER TABLE "projects" ADD COLUMN "next_request_number" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "backlog_items" ADD COLUMN "number" integer;
--> statement-breakpoint
UPDATE "backlog_items" b SET "number" = r."n"
FROM (
	SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "created_at", "id") AS "n"
	FROM "backlog_items"
) r
WHERE r."id" = b."id";
--> statement-breakpoint
UPDATE "projects" p SET "next_request_number" =
	coalesce((SELECT max(b."number") FROM "backlog_items" b WHERE b."project_id" = p."id"), 0) + 1;
--> statement-breakpoint
ALTER TABLE "backlog_items" ALTER COLUMN "number" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_project_number_unique" UNIQUE ("project_id", "number");
--> statement-breakpoint
-- Il numero dopo del progetto, sotto il lock della sua riga: due voci
-- concorrenti non prendono lo stesso. Anche una voce che cambia progetto
-- prende il numero dopo nel progetto nuovo.
CREATE FUNCTION backlog_items_assign_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' AND NEW."number" IS NOT NULL THEN
		RETURN NEW;
	END IF;
	IF TG_OP = 'UPDATE' AND NEW."project_id" IS NOT DISTINCT FROM OLD."project_id" THEN
		RETURN NEW;
	END IF;
	UPDATE "projects" SET "next_request_number" = "next_request_number" + 1
	WHERE "id" = NEW."project_id"
	RETURNING "next_request_number" - 1 INTO NEW."number";
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "backlog_items_assign_number" BEFORE INSERT OR UPDATE OF "project_id" ON "backlog_items"
	FOR EACH ROW EXECUTE FUNCTION backlog_items_assign_number();
