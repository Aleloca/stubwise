-- Gli stati senza l'enum (blocco T del ritiro del web vecchio, R0;
-- docs/plans/2026-11-28-ritiro-web-vecchio-piano.md §1.2). Additiva.
--
-- `triaged` non è uno stato del progetto (gli stati todo hanno ruolo `open`):
-- finora sopravviveva solo perché il triage e il webhook git scrivevano
-- l'enum, e il trigger teneva il valore scritto. Da qui lo dice `triaged_at`:
-- lo impostano quei due scrittori, lo azzera il trigger quando il ticket esce
-- dalla famiglia todo (rientrandoci da un'altra famiglia è di nuovo `open`).
ALTER TABLE "tickets" ADD COLUMN "triaged_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "tickets" SET "triaged_at" = "updated_at" WHERE "status" = 'triaged';
--> statement-breakpoint
-- Lo `status` di un ticket DERIVATO dal suo stato, in UN posto: il ruolo dello
-- stato (`legacy_status`), e `triaged` per un todo già smistato. È ciò che le
-- risposte dell'API chiamano `status`; nessun codice lo ricalcola a mano.
CREATE FUNCTION stubwise_ticket_status(p_status uuid, p_triaged timestamp with time zone) RETURNS "ticket_status"
LANGUAGE sql STABLE AS $$
	SELECT CASE
		WHEN ps."legacy_status" = 'open' AND p_triaged IS NOT NULL THEN 'triaged'::"ticket_status"
		ELSE ps."legacy_status"
	END
	FROM "project_statuses" ps
	WHERE ps."id" = p_status
$$;
--> statement-breakpoint
-- Dopo `tickets_status_sync` (i trigger BEFORE vanno in ordine di nome), quindi
-- con `status_id` già deciso anche per uno scrittore che scrive l'enum.
CREATE FUNCTION tickets_triaged_reset() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."triaged_at" IS NOT NULL
		AND (SELECT "family" FROM "project_statuses" WHERE "id" = NEW."status_id") IS DISTINCT FROM 'todo' THEN
		NEW."triaged_at" := NULL;
	END IF;
	-- Uno scrittore NUOVO tocca `triaged_at` (smistare, o dare `open`, o
	-- creare un ticket già smistato): la
	-- colonna enum, finché esiste, si riallinea allo status derivato, come la
	-- lasciava lo scrittore vecchio. Uno scrittore vecchio (un rollback) non
	-- tocca `triaged_at`, e il suo enum resta quello che ha scritto.
	IF (TG_OP = 'INSERT' AND NEW."triaged_at" IS NOT NULL)
		OR (TG_OP = 'UPDATE' AND NEW."triaged_at" IS DISTINCT FROM OLD."triaged_at") THEN
		NEW."status" := stubwise_ticket_status(NEW."status_id", NEW."triaged_at");
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "tickets_triaged_reset" BEFORE INSERT OR UPDATE ON "tickets" FOR EACH ROW EXECUTE FUNCTION tickets_triaged_reset();
