CREATE TYPE "public"."activity_report_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "activity_report_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"git_email" text NOT NULL,
	"author_name" text,
	"commit_count" integer DEFAULT 0 NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"repo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" "activity_report_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "git_authors_seen" (
	"email" text PRIMARY KEY NOT NULL,
	"author_name" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"author_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_identities_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "daily_report_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bitbucket_username" text;--> statement-breakpoint
ALTER TABLE "activity_report_entries" ADD CONSTRAINT "activity_report_entries_report_id_activity_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."activity_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_reports" ADD CONSTRAINT "activity_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_identities" ADD CONSTRAINT "git_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_report_entries_report_id_idx" ON "activity_report_entries" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_reports_project_date_unique" ON "activity_reports" USING btree ("project_id","date");--> statement-breakpoint
CREATE INDEX "git_identities_user_id_idx" ON "git_identities" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_bitbucket_username_unique" UNIQUE("bitbucket_username");