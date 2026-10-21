-- Modelli per operazione e consumi di ogni run AI (21 ott 2026).
-- Testo + CHECK sul catalogo di @stubwise/shared e non enum: niente ALTER TYPE
-- nel batch (vedi 0095_pat_kind.sql). Nuova operazione = si allarga il CHECK.
CREATE TABLE "ai_model_settings" (
	"operation" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "ai_model_settings_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'daily_report', 'weekly_brief', 'mail_classify', 'chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe')),
	CONSTRAINT "ai_model_settings_model_chk" CHECK (model in ('opus', 'sonnet', 'haiku', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8'))
);--> statement-breakpoint
ALTER TABLE "ai_model_settings" ADD CONSTRAINT "ai_model_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "worker_model_defaults" jsonb;--> statement-breakpoint
-- operation nasce nullable, si riempie dalle righe storiche, poi NOT NULL.
ALTER TABLE "agent_runs" ADD COLUMN "operation" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cache_creation_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill dell'operazione dalla fase. Il fix si divide per modello: oggi il
-- piano gira su opus e l'esecuzione su sonnet.
UPDATE "agent_runs" SET "operation" = CASE "phase"::text
  WHEN 'triage' THEN 'triage'
  WHEN 'review' THEN 'pr_review'
  WHEN 'email_classify' THEN 'mail_classify'
  WHEN 'fix' THEN CASE WHEN "model" LIKE '%opus%' THEN 'fix_plan' ELSE 'fix_execute' END
END;--> statement-breakpoint
-- Progetto: dal ticket del job, o dal repository della review; la posta resta null.
UPDATE "agent_runs" ar SET "project_id" = t."project_id"
  FROM "ai_jobs" j JOIN "tickets" t ON t."id" = j."ticket_id"
  WHERE ar."job_id" = j."id";--> statement-breakpoint
UPDATE "agent_runs" ar SET "project_id" = r."project_id"
  FROM "pr_reviews" pr JOIN "repositories" r ON r."id" = pr."repository_id"
  WHERE ar."pr_review_id" = pr."id";--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "operation" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "phase" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_owner_check";--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_check" CHECK (num_nonnulls(job_id, pr_review_id, email_message_id) <= 1);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_job_phase_check" CHECK (job_id is null or phase is not null);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'daily_report', 'weekly_brief', 'mail_classify', 'chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe'));--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_created_at_idx" ON "agent_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_operation_created_at_idx" ON "agent_runs" USING btree ("operation","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_project_id_idx" ON "agent_runs" USING btree ("project_id");
