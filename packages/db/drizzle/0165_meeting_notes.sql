-- Area 6, F5a: le riunioni registrate (vedi lo schema). L'email di Gemini,
-- la riunione (una per Doc), gli allegati degli eventi, le proposte della
-- riunione e l'operazione AI `meeting_summary`.
ALTER TABLE "email_messages" ADD COLUMN "kind" text DEFAULT 'email' NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_kind_chk" CHECK (kind in ('email', 'transcript'));
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE TABLE "meeting_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_file_id" text NOT NULL,
	"rfc_message_id" text,
	"source_message_id" uuid NOT NULL,
	"ical_uid" text,
	"event_starts_at" timestamp with time zone,
	"event_title" text,
	"doc_title" text,
	"doc_status" text DEFAULT 'reading' NOT NULL,
	"doc_reason" text,
	"summary" text,
	"attendee_emails" text[] DEFAULT '{}' NOT NULL,
	"project_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_notes_doc_status_chk" CHECK (doc_status in ('reading', 'ready', 'unreachable')),
	CONSTRAINT "meeting_notes_doc_reason_chk" CHECK (doc_reason is null or doc_reason in ('scope_missing', 'not_shared', 'deleted', 'too_long'))
);
--> statement-breakpoint
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_source_message_id_email_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_notes_doc_file_id_unique" ON "meeting_notes" USING btree ("doc_file_id");
--> statement-breakpoint
CREATE INDEX "meeting_notes_ical_uid_idx" ON "meeting_notes" USING btree ("ical_uid");
--> statement-breakpoint
CREATE INDEX "meeting_notes_reading_idx" ON "meeting_notes" USING btree ("next_attempt_at") WHERE doc_status = 'reading';
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD COLUMN "meeting_note_id" uuid;
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD CONSTRAINT "email_proposals_meeting_note_id_meeting_notes_id_fk" FOREIGN KEY ("meeting_note_id") REFERENCES "public"."meeting_notes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_proposals" DROP CONSTRAINT "email_proposals_audience_chk";
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD CONSTRAINT "email_proposals_audience_chk" CHECK (audience in ('mailbox_owner', 'mail_recipients', 'meeting_invitees'));
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_operation_chk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe'));
--> statement-breakpoint
ALTER TABLE "ai_model_settings" DROP CONSTRAINT "ai_model_settings_operation_chk";
--> statement-breakpoint
ALTER TABLE "ai_model_settings" ADD CONSTRAINT "ai_model_settings_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe'));
