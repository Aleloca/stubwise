-- Area 11, F5: l'operazione AI del lavoro di Claude sulla doc di prodotto
-- (`product_doc_update`, il suo modello in `ai_model_settings`), e la sosta per
-- la coda del progetto in pausa (`paused`, come il passo di un'automazione).
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_operation_chk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'automation_step', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe', 'support_triage_check', 'server_analysis', 'server_fix_plan', 'mail_reply_judgment', 'product_doc_update'));
--> statement-breakpoint
ALTER TABLE "ai_model_settings" DROP CONSTRAINT "ai_model_settings_operation_chk";
--> statement-breakpoint
ALTER TABLE "ai_model_settings" ADD CONSTRAINT "ai_model_settings_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'automation_step', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe', 'support_triage_check', 'server_analysis', 'server_fix_plan', 'mail_reply_judgment', 'product_doc_update'));
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" DROP CONSTRAINT "product_doc_jobs_held_reason_chk";
--> statement-breakpoint
ALTER TABLE "product_doc_jobs" ADD CONSTRAINT "product_doc_jobs_held_reason_chk" CHECK ("held_reason" IS NULL OR "held_reason" in ('limit', 'budget', 'section_busy', 'paused'));
