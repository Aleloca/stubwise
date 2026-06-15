CREATE TYPE "public"."resume_mode" AS ENUM('fix', 'execute');--> statement-breakpoint
ALTER TYPE "public"."ai_job_status" ADD VALUE 'pr_closed';--> statement-breakpoint
ALTER TYPE "public"."ai_job_status" ADD VALUE 'awaiting_plan_approval';--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "resume_mode" "resume_mode";--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "plan_text" text;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "plan_approval_min_effort" integer;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "notify_pr_closed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "notify_plan_review" boolean DEFAULT true NOT NULL;