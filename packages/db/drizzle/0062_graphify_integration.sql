ALTER TABLE "repositories" ADD COLUMN "graph_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "repo_graphs" (
	"repository_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"commit_sha" text,
	"node_count" integer,
	"edge_count" integer,
	"community_count" integer,
	"labeled" boolean DEFAULT false NOT NULL,
	"setup_pr_url" text,
	"error" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone,
	"force" boolean DEFAULT false NOT NULL,
	"error" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repo_graphs" ADD CONSTRAINT "repo_graphs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_jobs" ADD CONSTRAINT "graph_jobs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Un solo job attivo per (repository, kind): il debounce del webhook push
-- AGGIORNA il not_before del queued esistente invece di accodarne un secondo.
CREATE UNIQUE INDEX "graph_jobs_active_unique" ON "graph_jobs" USING btree ("repository_id","kind") WHERE status IN ('queued', 'running');
