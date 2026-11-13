-- Area 7, fetta 3 (13 nov 2026): i passi di Claude delle automazioni
-- (`docs/plans/2026-11-13-integrazione-area7-fetta3-plan.md`, S1 e C-F3-5).
--
-- L'operazione `automation_step` (testo + CHECK, mai un enum: nessun vincolo
-- di batch) e l'owner della riga di consumo: `automation_id` per un passo e
-- per una prova, `automation_run_id` solo per un passo di un'esecuzione (NULL
-- = una prova). Al più un owner, come prima. Nessun CHECK «la run solo con
-- l'automazione»: le due FK vanno a NULL in momenti diversi durante una
-- cascata (eliminare un progetto lo farebbe fallire, review F3 M11), e le
-- righe di consumo non si cancellano mai (sono la spesa del mese).
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_operation_chk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'automation_step', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe'));
--> statement-breakpoint
ALTER TABLE "ai_model_settings" DROP CONSTRAINT "ai_model_settings_operation_chk";
--> statement-breakpoint
ALTER TABLE "ai_model_settings" ADD CONSTRAINT "ai_model_settings_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'automation_step', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe'));
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "automation_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "automation_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_automation_run_id_automation_runs_id_fk" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_owner_check";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_owner_check" CHECK (num_nonnulls(job_id, pr_review_id, email_message_id, automation_id) <= 1);
--> statement-breakpoint
CREATE INDEX "agent_runs_automation_idx" ON "agent_runs" USING btree ("automation_id") WHERE "automation_id" IS NOT NULL;
