CREATE TYPE "public"."pr_review_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."pr_review_verdict" AS ENUM('approve', 'request_changes');--> statement-breakpoint
ALTER TYPE "public"."agent_run_phase" ADD VALUE 'review';--> statement-breakpoint
ALTER TYPE "public"."ticket_type" ADD VALUE 'review';--> statement-breakpoint
CREATE TABLE "pr_review_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text NOT NULL,
	"pr_title" text NOT NULL,
	"pr_body" text DEFAULT '' NOT NULL,
	"source_branch" text NOT NULL,
	"target_branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pr_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text NOT NULL,
	"pr_title" text NOT NULL,
	"head_sha" text NOT NULL,
	"ticket_id" uuid,
	"status" "pr_review_status" DEFAULT 'running' NOT NULL,
	"verdict" "pr_review_verdict",
	"summary" text,
	"error" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "job_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "pr_review_id" uuid;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "pr_review_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "pr_review_max_cost_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "notify_review_completed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_review_jobs" ADD CONSTRAINT "pr_review_jobs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD CONSTRAINT "pr_reviews_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_jobs_repository_pr_unique" ON "pr_review_jobs" USING btree ("repository_id","pr_number");--> statement-breakpoint
CREATE INDEX "pr_reviews_repository_pr_idx" ON "pr_reviews" USING btree ("repository_id","pr_number");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_pr_review_id_pr_reviews_id_fk" FOREIGN KEY ("pr_review_id") REFERENCES "public"."pr_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_pr_review_id_idx" ON "agent_runs" USING btree ("pr_review_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_check" CHECK (num_nonnulls(job_id, pr_review_id) = 1);