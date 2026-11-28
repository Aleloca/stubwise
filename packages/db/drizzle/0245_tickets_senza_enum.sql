-- R3 del ritiro del web vecchio, il passo dei dati del blocco T
-- (docs/plans/2026-11-28-ritiro-web-vecchio-piano.md §1.1 e §1.2;
-- docs/invariants/tasks.md). Da R0 nessun codice legge o scrive l'enum
-- `tickets.status`: lo stato vero è `status_id`, lo `status` delle risposte si
-- deriva (`stubwise_ticket_status`). Qui se ne vanno la colonna, il tipo
-- `ticket_status` e i due trigger che lo leggevano. Un trigger solo,
-- `tickets_state`, fa senza l'enum ciò che di loro resta.
--
-- ⚠️ Dopo questa migrazione si scende AL MASSIMO a R2: il codice di prima di
-- R0 nomina la colonna (deploy-log, «R3 — gli stati senza l'enum»).
-- ⚠️ Il numero lascia un margine dopo la 0240 (#146). Deve restare l'ULTIMA
-- del journal, anche di `when`: drizzle applica per `when`, e una migrazione
-- con un `when` più piccolo, arrivata dopo, si salterebbe in silenzio. Lo
-- tiene vero `migration-0245.test.ts` («il journal delle migrazioni»).
-- Ogni DROP in uno statement a sé; nessun `ADD VALUE` (CLAUDE.md, «il batch
-- gira in UNA transazione»).

-- 1. I due trigger che leggono l'enum, e le loro funzioni. Prima della
--    colonna: `tickets_status_sync` dichiara `UPDATE OF "status"`, quindi ne
--    dipende.
DROP TRIGGER "tickets_status_sync" ON "tickets";
--> statement-breakpoint
DROP TRIGGER "tickets_triaged_reset" ON "tickets";
--> statement-breakpoint
DROP FUNCTION tickets_status_sync();
--> statement-breakpoint
DROP FUNCTION tickets_triaged_reset();
--> statement-breakpoint
-- 2. La colonna. Con lei va `tickets_project_id_status_idx` (un indice sulla
--    colonna cade con lei); gli elenchi filtrano per `status_id`, che ha il suo
--    indice (0108).
ALTER TABLE "tickets" DROP COLUMN "status";
--> statement-breakpoint
-- 3. Il ruolo di uno stato resta, come text con gli stessi valori: la
--    pipeline, l'MCP e il mobile lo conoscono come `status`.
ALTER TABLE "project_statuses" ALTER COLUMN "legacy_status" TYPE text USING "legacy_status"::text;
--> statement-breakpoint
ALTER TABLE "project_statuses" ADD CONSTRAINT "project_statuses_legacy_status_chk"
	CHECK ("legacy_status" IN ('open', 'triaged', 'in_progress', 'in_review', 'done', 'closed'));
--> statement-breakpoint
-- 4. Le funzioni della regola, con text al posto del tipo. Cambia la firma,
--    quindi DROP e CREATE (i corpi sono quelli di 0108 e 0240).
DROP FUNCTION stubwise_ticket_status(uuid, timestamp with time zone);
--> statement-breakpoint
DROP FUNCTION stubwise_status_for_legacy(uuid, "ticket_status", uuid);
--> statement-breakpoint
DROP FUNCTION stubwise_legacy_family("ticket_status");
--> statement-breakpoint
CREATE FUNCTION stubwise_legacy_family(s text) RETURNS text
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
-- Lo stato in cui un ticket va quando gli si dà un ruolo (`statusIdForRole`).
-- Regola di 0108: se lo stato corrente ha già quel ruolo, o (todo,
-- in_progress) è già nella famiglia giusta, resta dov'è. Altrimenti:
--   todo        → primo todo
--   in_progress → primo active
--   in_review   → primo active DOPO quello corrente con ruolo in_review,
--                 altrimenti l'ultimo active (mai indietro)
--   done        → primo closed con ruolo done, altrimenti primo closed
--   closed      → primo closed con ruolo closed, altrimenti ultimo closed
CREATE FUNCTION stubwise_status_for_legacy(p_project uuid, p_legacy text, p_current uuid) RETURNS uuid
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
-- Lo `status` di un ticket DERIVATO dal suo stato, in UN posto (0240): il
-- ruolo dello stato, e `triaged` per un todo già smistato.
CREATE FUNCTION stubwise_ticket_status(p_status uuid, p_triaged timestamp with time zone) RETURNS text
LANGUAGE sql STABLE AS $$
	SELECT CASE
		WHEN ps."legacy_status" = 'open' AND p_triaged IS NOT NULL THEN 'triaged'
		ELSE ps."legacy_status"
	END
	FROM "project_statuses" ps
	WHERE ps."id" = p_status
$$;
--> statement-breakpoint
-- 5. Il trigger che resta, senza l'enum. Le regole di `tickets_status_sync`
--    (0108) e di `tickets_triaged_reset` (0240) che non nominano la colonna:
--   - INSERT senza `status_id`: il primo todo (il ruolo `open`, il default
--     dell'enum di prima); con `status_id`: deve essere del progetto;
--   - un ticket che cambia progetto senza dire lo stato: lo stato del nuovo
--     progetto per il RUOLO dello stato di prima (`stubwise_status_for_legacy`);
--   - uno `status_id` scritto: deve essere del progetto; e se lo scrittore
--     non dice `triaged_at`, il segno dello smistamento cade (come uno
--     spostamento fra due todo del web vecchio);
--   - `closed_at`: entrando nella famiglia closed la data di adesso, fra due
--     closed resta, fuori da closed null;
--   - `triaged_at`: fuori dalla famiglia todo è sempre null.
CREATE FUNCTION tickets_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	st "project_statuses"%ROWTYPE;
	old_family text;
	sid_changed boolean;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW."status_id" IS NULL THEN
			NEW."status_id" := stubwise_status_for_legacy(NEW."project_id", 'open', NULL);
		END IF;
		SELECT * INTO st FROM "project_statuses" WHERE "id" = NEW."status_id";
		IF st."id" IS NULL OR st."project_id" <> NEW."project_id" THEN
			RAISE EXCEPTION 'status % non appartiene al progetto %', NEW."status_id", NEW."project_id"
				USING ERRCODE = '23503';
		END IF;
		IF st."family" = 'closed' THEN
			NEW."closed_at" := coalesce(NEW."closed_at", now());
		ELSE
			NEW."closed_at" := NULL;
		END IF;
		IF st."family" <> 'todo' THEN
			NEW."triaged_at" := NULL;
		END IF;
		RETURN NEW;
	END IF;

	sid_changed := NEW."status_id" IS DISTINCT FROM OLD."status_id";

	IF NEW."project_id" IS DISTINCT FROM OLD."project_id" AND NOT sid_changed THEN
		-- Cambia progetto: lo stato dal ruolo dello stato di prima. Il segno
		-- dello smistamento resta (lo toglie solo l'uscita da todo).
		NEW."status_id" := stubwise_status_for_legacy(
			NEW."project_id",
			(SELECT "legacy_status" FROM "project_statuses" WHERE "id" = OLD."status_id"),
			NULL
		);
	ELSIF sid_changed THEN
		SELECT * INTO st FROM "project_statuses" WHERE "id" = NEW."status_id";
		IF st."id" IS NULL OR st."project_id" <> NEW."project_id" THEN
			RAISE EXCEPTION 'status % non appartiene al progetto %', NEW."status_id", NEW."project_id"
				USING ERRCODE = '23503';
		END IF;
		IF NEW."triaged_at" IS NOT DISTINCT FROM OLD."triaged_at" THEN
			NEW."triaged_at" := NULL;
		END IF;
	ELSIF NEW."triaged_at" IS NOT DISTINCT FROM OLD."triaged_at" THEN
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
	IF st."family" <> 'todo' THEN
		NEW."triaged_at" := NULL;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tickets_state" BEFORE INSERT OR UPDATE OF "status_id", "project_id", "triaged_at" ON "tickets"
	FOR EACH ROW EXECUTE FUNCTION tickets_state();
--> statement-breakpoint
-- 6. Infine il tipo: nessuna colonna né funzione lo nomina più.
DROP TYPE "ticket_status";
