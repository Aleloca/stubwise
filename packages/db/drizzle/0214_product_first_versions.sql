-- Area 11, F6: la prima versione di Claude in uno spazio Product vuoto. Una
-- viva (`writing`) per progetto alla volta. Le fonti si salvano come
-- riferimenti (il testo incollato SENZA corpo: `pasted_text` lo tiene solo
-- finché il lavoro non l'ha letto). Il lavoro è della coda della doc
-- (`product_doc_jobs`, `source_kind = 'first_version'`); le pagine si scrivono
-- una alla volta, con una revisione `first_version` (senza segni).
CREATE TABLE "product_first_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"started_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"sources" jsonb NOT NULL,
	"pasted_text" text,
	"status" text DEFAULT 'writing' NOT NULL,
	"interrupted" boolean DEFAULT false NOT NULL,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft" jsonb,
	"written" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accepted_page_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"undone_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "product_first_versions_status_chk" CHECK ("status" in ('writing', 'done', 'undone'))
);
--> statement-breakpoint
CREATE INDEX "product_first_versions_project_idx" ON "product_first_versions" ("project_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "product_first_versions_writing_unique" ON "product_first_versions" ("project_id") WHERE "status" = 'writing';
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" DROP CONSTRAINT "product_doc_jobs_source_kind_chk";
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" ADD CONSTRAINT "product_doc_jobs_source_kind_chk" CHECK ("source_kind" in ('email', 'meeting', 'decision', 'task', 'release', 'first_version'));
--> statement-breakpoint
ALTER TABLE "product_page_revisions" DROP CONSTRAINT "product_page_revisions_kind_chk";
--> statement-breakpoint
ALTER TABLE "product_page_revisions" ADD CONSTRAINT "product_page_revisions_kind_chk" CHECK ("kind" in ('create', 'edit', 'rename', 'move', 'undo', 'claude', 'first_version'));
