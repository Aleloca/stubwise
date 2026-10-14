-- Sessioni di refinement del backlog (design 2026-10-14). Nessun ALTER TYPE:
-- status, closed_reason e field sono text con CHECK; i motivi nuovi di
-- agent_session_inputs.reason e l'etichetta `refine` di active_segment_label
-- sono colonne text senza CHECK (bastano gli enum Zod).
CREATE TABLE "backlog_refine_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cli_session_id" text,
	"started_by_user_id" uuid,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlog_refine_sessions_item_id_unique" UNIQUE("item_id"),
	CONSTRAINT "backlog_refine_sessions_agent_session_id_unique" UNIQUE("agent_session_id"),
	CONSTRAINT "backlog_refine_sessions_status_chk" CHECK (status in ('active','closed')),
	CONSTRAINT "backlog_refine_sessions_closed_reason_chk" CHECK (closed_reason is null or closed_reason in ('user','idle','item_closed')),
	CONSTRAINT "backlog_refine_sessions_closed_chk" CHECK ((status = 'active' and closed_at is null and closed_reason is null) or (status = 'closed' and closed_at is not null and closed_reason is not null))
);
--> statement-breakpoint
ALTER TABLE "backlog_refine_sessions" ADD CONSTRAINT "backlog_refine_sessions_item_id_backlog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backlog_refine_sessions" ADD CONSTRAINT "backlog_refine_sessions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backlog_refine_sessions" ADD CONSTRAINT "backlog_refine_sessions_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "backlog_refine_sessions_active_idx" ON "backlog_refine_sessions" ("last_activity_at") WHERE status = 'active';
--> statement-breakpoint
CREATE TABLE "backlog_item_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"field" text NOT NULL,
	"previous" jsonb NOT NULL,
	"agent_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlog_item_revisions_field_chk" CHECK (field in ('document','implementation_plan','metadata'))
);
--> statement-breakpoint
ALTER TABLE "backlog_item_revisions" ADD CONSTRAINT "backlog_item_revisions_item_id_backlog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backlog_item_revisions" ADD CONSTRAINT "backlog_item_revisions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "backlog_item_revisions_item_created_idx" ON "backlog_item_revisions" ("item_id","created_at");
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_kind_chk";
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_kind_chk" CHECK (kind in ('ai_job','pr_review','backlog_item','backlog_job','doc_generation','email_message','project_brief','daily_report','backlog_refine'));
