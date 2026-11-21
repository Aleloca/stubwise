-- Area 11, F6, Task 4: «aggiorna <pagina> da questa email» (la voce
-- `updateProductPage` di Claude). Una richiesta per UNA fonte (un'email o una
-- riunione) e UNA pagina, chiesta da una persona: il lavoro della coda della
-- doc è `source_kind = 'page_update'` con `source_id` = questa riga (come la
-- prima versione e le bozze), così la fonte già letta dal lavoro automatico
-- (`product_doc_jobs_source_unique`) si può rileggere a mano. Una sola viva
-- per pagina e fonte: la chiude il worker (`finished_at`).
CREATE TABLE "product_page_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"page_id" uuid NOT NULL REFERENCES "product_pages"("id") ON DELETE CASCADE,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "product_page_updates_source_kind_chk" CHECK ("source_kind" in ('email', 'meeting'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_page_updates_live_key" ON "product_page_updates" ("page_id", "source_kind", "source_id") WHERE "finished_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" DROP CONSTRAINT "product_doc_jobs_source_kind_chk";
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" ADD CONSTRAINT "product_doc_jobs_source_kind_chk" CHECK ("source_kind" in ('email', 'meeting', 'decision', 'task', 'release', 'first_version', 'wireframe', 'page_update'));
