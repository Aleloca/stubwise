-- Area 8, «Clienti in attesa» (15 nov 2026): il giudizio di Claude «serve una
-- MIA risposta?» su un thread, per casella. Si scrive sul messaggio giudicato
-- e vale finché quel messaggio è l'ULTIMO del thread: un messaggio nuovo è un
-- ultimo messaggio senza giudizio (idempotente, nessun giro). Piano:
-- docs/plans/2026-11-15-integrazione-area8-clienti-in-attesa-plan.md.
ALTER TABLE "email_messages" ADD COLUMN "reply_judgment" jsonb;
--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "reply_judgment_attempts" smallint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_operation_chk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'automation_step', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe', 'support_triage_check', 'server_analysis', 'server_fix_plan', 'mail_reply_judgment'));
--> statement-breakpoint
ALTER TABLE "ai_model_settings" DROP CONSTRAINT "ai_model_settings_operation_chk";
--> statement-breakpoint
ALTER TABLE "ai_model_settings" ADD CONSTRAINT "ai_model_settings_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'automation_step', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe', 'support_triage_check', 'server_analysis', 'server_fix_plan', 'mail_reply_judgment'));
