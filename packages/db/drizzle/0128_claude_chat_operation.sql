-- Chat con Claude, fetta 1 (10 nov 2026): l'operazione AI `claude_chat` per i
-- turni delle conversazioni libere (modello configurabile, consumi in
-- `agent_runs`). Aggiorna i due CHECK derivati da `AI_OPERATIONS`.
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_operation_chk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'daily_report', 'weekly_brief', 'mail_classify', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe'));
--> statement-breakpoint
ALTER TABLE "ai_model_settings" DROP CONSTRAINT "ai_model_settings_operation_chk";
--> statement-breakpoint
ALTER TABLE "ai_model_settings" ADD CONSTRAINT "ai_model_settings_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'daily_report', 'weekly_brief', 'mail_classify', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe'));
