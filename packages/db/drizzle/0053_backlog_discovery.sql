CREATE TYPE "public"."backlog_item_source" AS ENUM('ticket', 'manual');--> statement-breakpoint
CREATE TYPE "public"."backlog_item_status" AS ENUM('new', 'refining', 'ready', 'converted', 'archived');--> statement-breakpoint
CREATE TYPE "public"."backlog_job_kind" AS ENUM('intake', 'deep_dive');--> statement-breakpoint
CREATE TYPE "public"."backlog_job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."backlog_risk" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."backlog_ticket_role" AS ENUM('origin', 'converted_to');--> statement-breakpoint
CREATE TABLE "backlog_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backlog_item_tickets" (
	"item_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"role" "backlog_ticket_role" DEFAULT 'origin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlog_item_tickets_item_id_ticket_id_pk" PRIMARY KEY("item_id","ticket_id")
);
--> statement-breakpoint
CREATE TABLE "backlog_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"document" text DEFAULT '' NOT NULL,
	"status" "backlog_item_status" DEFAULT 'new' NOT NULL,
	"effort" integer,
	"risk" "backlog_risk",
	"risk_note" text,
	"urgency" "ticket_priority",
	"request_count" integer DEFAULT 1 NOT NULL,
	"similar_to_id" uuid,
	"merged_into_id" uuid,
	"suggested" jsonb,
	"embedding" vector(1024),
	"source" "backlog_item_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backlog_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "backlog_job_kind" NOT NULL,
	"status" "backlog_job_status" DEFAULT 'queued' NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "backlog_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "backlog_chat_messages" ADD CONSTRAINT "backlog_chat_messages_item_id_backlog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_item_tickets" ADD CONSTRAINT "backlog_item_tickets_item_id_backlog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_item_tickets" ADD CONSTRAINT "backlog_item_tickets_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_similar_to_id_backlog_items_id_fk" FOREIGN KEY ("similar_to_id") REFERENCES "public"."backlog_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_merged_into_id_backlog_items_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."backlog_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_jobs" ADD CONSTRAINT "backlog_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backlog_chat_messages_item_idx" ON "backlog_chat_messages" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "backlog_items_project_status_idx" ON "backlog_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "backlog_jobs_status_idx" ON "backlog_jobs" USING btree ("status","created_at");