-- Area 11, F5: Claude aggiorna la doc di prodotto dalle fonti. La coda del
-- lavoro (`product_doc_jobs`), i trigger che la riempiono nella transazione di
-- chi scrive (come gli eventi delle automazioni, 0169), i segni di Claude, e le
-- colonne nuove di revisioni e commenti.
CREATE TABLE "product_doc_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"held_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "product_doc_jobs_source_kind_chk" CHECK ("source_kind" in ('email', 'meeting', 'decision', 'task', 'release')),
	CONSTRAINT "product_doc_jobs_status_chk" CHECK ("status" in ('queued', 'running', 'held', 'done', 'failed')),
	CONSTRAINT "product_doc_jobs_held_chk" CHECK (("status" = 'held') = ("held_reason" IS NOT NULL)),
	CONSTRAINT "product_doc_jobs_held_reason_chk" CHECK ("held_reason" IS NULL OR "held_reason" in ('limit', 'budget', 'section_busy'))
);
--> statement-breakpoint
-- Una fonte si legge UNA volta per progetto.
CREATE UNIQUE INDEX "product_doc_jobs_source_unique" ON "product_doc_jobs" ("project_id", "source_kind", "source_id");
--> statement-breakpoint
CREATE INDEX "product_doc_jobs_queued_idx" ON "product_doc_jobs" ("created_at") WHERE "status" = 'queued';
--> statement-breakpoint
-- Accoda una fonte per il progetto, SOLO se il progetto ha almeno una pagina di
-- prodotto (nessun lavoro dove non c'è una doc), e una volta sola.
CREATE FUNCTION "product_doc_enqueue"(p_project uuid, p_kind text, p_source uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	IF p_project IS NULL OR NOT EXISTS (SELECT 1 FROM "product_pages" WHERE "project_id" = p_project) THEN
		RETURN;
	END IF;
	INSERT INTO "product_doc_jobs" ("project_id", "source_kind", "source_id") VALUES (p_project, p_kind, p_source)
	ON CONFLICT ("project_id", "source_kind", "source_id") DO NOTHING;
END;
$$;
--> statement-breakpoint
-- Una task che ENTRA nella famiglia «closed» (come `automation_event_task_closed`).
CREATE FUNCTION "product_doc_task_closed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF (SELECT "family" FROM "project_statuses" WHERE "id" = NEW."status_id") = 'closed'
		AND coalesce((SELECT "family" FROM "project_statuses" WHERE "id" = OLD."status_id"), '') <> 'closed' THEN
		PERFORM "product_doc_enqueue"(NEW."project_id", 'task', NEW."id");
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tickets_product_doc_closed" AFTER UPDATE ON "tickets"
	FOR EACH ROW WHEN (OLD."status_id" IS DISTINCT FROM NEW."status_id")
	EXECUTE FUNCTION "product_doc_task_closed"();
--> statement-breakpoint
CREATE FUNCTION "product_doc_decision"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "product_doc_enqueue"(NEW."project_id", 'decision', NEW."id");
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_decisions_product_doc" AFTER INSERT ON "project_decisions"
	FOR EACH ROW EXECUTE FUNCTION "product_doc_decision"();
--> statement-breakpoint
CREATE FUNCTION "product_doc_release"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "product_doc_enqueue"(NEW."project_id", 'release', NEW."id");
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "releases_product_doc" AFTER INSERT ON "releases"
	FOR EACH ROW EXECUTE FUNCTION "product_doc_release"();
--> statement-breakpoint
-- Una riunione col documento pronto e un progetto (all'insert o quando lo diventa).
CREATE FUNCTION "product_doc_meeting"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."doc_status" = 'ready' AND NEW."project_id" IS NOT NULL
		AND (TG_OP = 'INSERT' OR OLD."doc_status" IS DISTINCT FROM 'ready' OR OLD."project_id" IS DISTINCT FROM NEW."project_id") THEN
		PERFORM "product_doc_enqueue"(NEW."project_id", 'meeting', NEW."id");
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "meeting_notes_product_doc" AFTER INSERT OR UPDATE OF "doc_status", "project_id" ON "meeting_notes"
	FOR EACH ROW EXECUTE FUNCTION "product_doc_meeting"();
--> statement-breakpoint
-- Una proposta della posta con un progetto, di un messaggio AMMESSO (N-2 = a).
-- La fonte è il messaggio: lo stesso messaggio si legge una volta per progetto.
CREATE FUNCTION "product_doc_email"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM "email_messages" WHERE "id" = NEW."email_message_id" AND "admitted") THEN
		PERFORM "product_doc_enqueue"(NEW."project_id", 'email', NEW."email_message_id");
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "email_proposals_product_doc" AFTER INSERT ON "email_proposals"
	FOR EACH ROW EXECUTE FUNCTION "product_doc_email"();
--> statement-breakpoint
-- I segni di Claude: uno per ancora di una revisione `claude`.
CREATE TABLE "product_claude_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL REFERENCES "product_page_revisions"("id") ON DELETE CASCADE,
	"page_id" uuid NOT NULL REFERENCES "product_pages"("id") ON DELETE CASCADE,
	"anchor_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_claude_marks_status_chk" CHECK ("status" in ('open', 'looks_good', 'undone'))
);
--> statement-breakpoint
CREATE INDEX "product_claude_marks_page_idx" ON "product_claude_marks" ("page_id");
--> statement-breakpoint
-- Le revisioni: anche `undo` e `claude`, con la fonte, `via` e per conto di chi.
ALTER TABLE "product_page_revisions" DROP CONSTRAINT "product_page_revisions_kind_chk";
--> statement-breakpoint
ALTER TABLE "product_page_revisions" ADD CONSTRAINT "product_page_revisions_kind_chk" CHECK ("kind" in ('create', 'edit', 'rename', 'move', 'undo', 'claude'));
--> statement-breakpoint
ALTER TABLE "product_page_revisions" ADD COLUMN "source_kind" text;
--> statement-breakpoint
ALTER TABLE "product_page_revisions" ADD COLUMN "source_id" uuid;
--> statement-breakpoint
ALTER TABLE "product_page_revisions" ADD COLUMN "via" text;
--> statement-breakpoint
ALTER TABLE "product_page_revisions" ADD COLUMN "on_behalf_of" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "product_page_revisions" ADD CONSTRAINT "product_page_revisions_via_chk" CHECK ("via" IS NULL OR "via" = 'claude');
--> statement-breakpoint
-- Una revisione di Claude dice sempre la sua fonte.
ALTER TABLE "product_page_revisions" ADD CONSTRAINT "product_page_revisions_claude_source_chk" CHECK ("kind" <> 'claude' OR ("source_kind" IS NOT NULL AND "source_id" IS NOT NULL AND "via" = 'claude'));
--> statement-breakpoint
-- I commenti: la parte di domanda di Claude, e la sua risposta (una sola, solo a una domanda).
ALTER TABLE "product_comments" ADD COLUMN "question" jsonb;
--> statement-breakpoint
ALTER TABLE "product_comments" ADD COLUMN "answer" jsonb;
--> statement-breakpoint
ALTER TABLE "product_comments" ADD CONSTRAINT "product_comments_answer_chk" CHECK ("answer" IS NULL OR "question" IS NOT NULL);
