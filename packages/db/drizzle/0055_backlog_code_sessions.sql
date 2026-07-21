CREATE TYPE "public"."backlog_code_session_status" AS ENUM('active', 'closed');--> statement-breakpoint
ALTER TYPE "public"."backlog_job_kind" ADD VALUE 'chat_turn';--> statement-breakpoint
CREATE TABLE "backlog_code_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"status" "backlog_code_session_status" DEFAULT 'active' NOT NULL,
	"cli_session_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "backlog_code_sessions" ADD CONSTRAINT "backlog_code_sessions_item_id_backlog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_code_sessions" ADD CONSTRAINT "backlog_code_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backlog_code_sessions_active_item_unique" ON "backlog_code_sessions" USING btree ("item_id") WHERE status = 'active';