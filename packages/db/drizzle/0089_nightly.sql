-- Giro notturno (design 2026-10-15 §3-§5): riassunti dei commit, coda del giro
-- e commit che una pagina in escalation non ha assorbito. Additiva.
CREATE TABLE "commit_summaries" (
	"repository_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"author_name" text NOT NULL,
	"author_email" text NOT NULL,
	"subject" text NOT NULL,
	"summary" text NOT NULL,
	"files" text[] DEFAULT '{}' NOT NULL,
	"areas" text[] DEFAULT '{}' NOT NULL,
	"noise" boolean DEFAULT false NOT NULL,
	"on_default_branch" boolean DEFAULT false NOT NULL,
	"documented_at" timestamp with time zone,
	"model" text,
	"cost_usd" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commit_summaries_repository_id_sha_pk" PRIMARY KEY("repository_id","sha"),
	CONSTRAINT "commit_summaries_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "commit_summaries_repo_committed_idx" ON "commit_summaries" ("repository_id","committed_at");
--> statement-breakpoint
CREATE INDEX "commit_summaries_undocumented_idx" ON "commit_summaries" ("repository_id") WHERE on_default_branch AND documented_at IS NULL;
--> statement-breakpoint
CREATE TABLE "nightly_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failed_nights" integer DEFAULT 0 NOT NULL,
	"last_failed_night" date,
	"last_error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"night" date NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nightly_items_phase_chk" CHECK (phase IN ('summary','daily_report','release','page_update','page_create')),
	CONSTRAINT "nightly_items_status_chk" CHECK (status IN ('pending','done','escalated')),
	CONSTRAINT "nightly_items_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
	CONSTRAINT "nightly_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "nightly_items_key_uq" ON "nightly_items" ("repository_id","phase","key");
--> statement-breakpoint
CREATE INDEX "nightly_items_pending_idx" ON "nightly_items" ("repository_id","phase","created_at") WHERE status = 'pending';
--> statement-breakpoint
CREATE TABLE "doc_page_pending_commits" (
	"page_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_page_pending_commits_page_id_sha_pk" PRIMARY KEY("page_id","sha"),
	CONSTRAINT "doc_page_pending_commits_page_id_doc_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "doc_pages"("id") ON DELETE cascade,
	CONSTRAINT "doc_page_pending_commits_commit_fk" FOREIGN KEY ("repository_id","sha") REFERENCES "commit_summaries"("repository_id","sha") ON DELETE cascade
);
