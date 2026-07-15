CREATE TABLE "activity_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"sha" text NOT NULL,
	"author_email" text NOT NULL,
	"author_name" text,
	"committed_at" timestamp with time zone NOT NULL,
	"subject" text NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"ai_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "activity_report_entries" CASCADE;--> statement-breakpoint
ALTER TABLE "activity_commits" ADD CONSTRAINT "activity_commits_report_id_activity_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."activity_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_commits" ADD CONSTRAINT "activity_commits_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_commits_report_repo_sha_unique" ON "activity_commits" USING btree ("report_id","repo_id","sha");--> statement-breakpoint
CREATE INDEX "activity_commits_report_id_idx" ON "activity_commits" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "activity_commits_author_email_idx" ON "activity_commits" USING btree ("author_email");