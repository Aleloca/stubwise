-- Area 11, F5, revisione indipendente (21 nov 2026). La coda della doc di
-- prodotto ricorda il lavoro fatto, così un lavoro ripreso non richiama il
-- modello né riscrive le pagine già scritte:
-- - `facts`: i fatti che il modello ha restituito (una volta sola);
-- - `answered_at`: quando, per il freno per progetto alle ondate;
-- - `pages_done`: le pagine già scritte (nella transazione dello scrittore);
-- - `not_before`: un lavoro rimesso in coda aspetta fino a lì;
-- - `last_held_reason`: l'ultima sosta, che resta finché il lavoro non finisce
--   (la riga «Claude riprende quando…» non sparisce a ogni ripresa).
ALTER TABLE "product_doc_jobs" ADD COLUMN "facts" jsonb;
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" ADD COLUMN "answered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" ADD COLUMN "pages_done" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" ADD COLUMN "not_before" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" ADD COLUMN "last_held_reason" text;
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" ADD CONSTRAINT "product_doc_jobs_last_held_reason_chk" CHECK ("last_held_reason" IS NULL OR "last_held_reason" in ('limit', 'budget', 'section_busy', 'paused'));
--> statement-breakpoint
CREATE INDEX "product_claude_marks_revision_idx" ON "product_claude_marks" ("revision_id");
--> statement-breakpoint
-- L'email: alla proposta, quando la proposta cambia progetto, e quando il
-- messaggio è ammesso DOPO. Una proposta scartata («Non fare nulla») non
-- accoda (il prototipo: la fonte è la classificazione o l'attribuzione).
CREATE OR REPLACE FUNCTION "product_doc_email"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."status" <> 'ignored' AND EXISTS (SELECT 1 FROM "email_messages" WHERE "id" = NEW."email_message_id" AND "admitted") THEN
		PERFORM "product_doc_enqueue"(NEW."project_id", 'email', NEW."email_message_id");
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER "email_proposals_product_doc" ON "email_proposals";
--> statement-breakpoint
CREATE TRIGGER "email_proposals_product_doc" AFTER INSERT OR UPDATE OF "project_id" ON "email_proposals"
	FOR EACH ROW EXECUTE FUNCTION "product_doc_email"();
--> statement-breakpoint
CREATE FUNCTION "product_doc_email_admitted"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
	FOR p IN SELECT "project_id" FROM "email_proposals" WHERE "email_message_id" = NEW."id" AND "status" <> 'ignored' LOOP
		PERFORM "product_doc_enqueue"(p."project_id", 'email', NEW."id");
	END LOOP;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "email_messages_product_doc" AFTER UPDATE OF "admitted" ON "email_messages"
	FOR EACH ROW WHEN (NEW."admitted" AND NOT OLD."admitted")
	EXECUTE FUNCTION "product_doc_email_admitted"();
