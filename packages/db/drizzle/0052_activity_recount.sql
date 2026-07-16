CREATE TABLE "activity_recount_jobs" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_reports" ADD COLUMN "stale_commit_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_recount_jobs" ADD CONSTRAINT "activity_recount_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;