-- Integrazione area 2, fetta 4 (10 nov 2026, review): lo stato in cui una
-- voce era quando è stata archiviata, perché il «Ripristina» dell'app lo
-- decida il SERVER e non il client. Lo scrive il trigger a OGNI
-- archiviazione, da qualunque percorso (app nuova, web vecchio, worker), e lo
-- azzera quando la voce esce dall'archivio. Le archiviate di prima restano
-- NULL: il loro stato precedente non è noto, e si ripristinano a «new».
ALTER TABLE "backlog_items" ADD COLUMN "archived_from" "backlog_item_status";
--> statement-breakpoint
CREATE FUNCTION backlog_items_archived_from() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."status" = 'archived' AND OLD."status" IS DISTINCT FROM 'archived' THEN
		NEW."archived_from" := OLD."status";
	ELSIF NEW."status" IS DISTINCT FROM 'archived' THEN
		NEW."archived_from" := NULL;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "backlog_items_archived_from" BEFORE UPDATE OF "status" ON "backlog_items"
	FOR EACH ROW EXECUTE FUNCTION backlog_items_archived_from();
