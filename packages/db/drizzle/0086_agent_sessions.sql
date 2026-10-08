CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"project_id" uuid,
	"ticket_id" uuid,
	"ai_job_id" uuid,
	"backlog_item_id" uuid,
	"pr_review_id" uuid,
	"doc_generation_id" uuid,
	"backlog_job_id" uuid,
	"mailbox_owner_user_id" uuid,
	"active_segment_id" text,
	"active_segment_label" text,
	"active_segment_interactive" boolean DEFAULT false NOT NULL,
	"live_segment_ids" text[] DEFAULT '{}' NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	CONSTRAINT "agent_sessions_owner_key_unique" UNIQUE("owner_key"),
	CONSTRAINT "agent_sessions_kind_chk" CHECK (kind in ('ai_job','pr_review','backlog_item','backlog_job','doc_generation','email_message','project_brief','daily_report')),
	CONSTRAINT "agent_sessions_email_owner_chk" CHECK (kind <> 'email_message' OR mailbox_owner_user_id IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_backlog_item_id_backlog_items_id_fk" FOREIGN KEY ("backlog_item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_pr_review_id_pr_reviews_id_fk" FOREIGN KEY ("pr_review_id") REFERENCES "public"."pr_reviews"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_doc_generation_id_doc_generations_id_fk" FOREIGN KEY ("doc_generation_id") REFERENCES "public"."doc_generations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_backlog_job_id_backlog_jobs_id_fk" FOREIGN KEY ("backlog_job_id") REFERENCES "public"."backlog_jobs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_mailbox_owner_user_id_users_id_fk" FOREIGN KEY ("mailbox_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_sessions_last_activity_idx" ON "agent_sessions" ((coalesce("last_event_at", "started_at")));
--> statement-breakpoint
CREATE INDEX "agent_sessions_live_idx" ON "agent_sessions" ("heartbeat_at") WHERE cardinality("live_segment_ids") > 0;
--> statement-breakpoint
CREATE INDEX "agent_sessions_ticket_id_idx" ON "agent_sessions" ("ticket_id");
--> statement-breakpoint
CREATE TABLE "agent_session_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"segment_id" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_events_type_chk" CHECK (type in ('segment_start','assistant_text','tool_use','tool_result','input','turn_end','segment_end'))
);
--> statement-breakpoint
ALTER TABLE "agent_session_events" ADD CONSTRAINT "agent_session_events_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_session_events_session_id_idx" ON "agent_session_events" ("session_id","id");
--> statement-breakpoint
CREATE INDEX "agent_session_events_created_at_idx" ON "agent_session_events" ("created_at");
--> statement-breakpoint
CREATE TABLE "agent_session_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"author_user_id" uuid,
	"text" text NOT NULL,
	"interrupt" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "agent_session_inputs_status_chk" CHECK (status in ('pending','delivered','undelivered'))
);
--> statement-breakpoint
ALTER TABLE "agent_session_inputs" ADD CONSTRAINT "agent_session_inputs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_inputs" ADD CONSTRAINT "agent_session_inputs_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_session_inputs_pending_idx" ON "agent_session_inputs" ("session_id") WHERE "status" = 'pending';
