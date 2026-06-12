CREATE TYPE "public"."notification_format" AS ENUM('slack', 'discord', 'generic');--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"webhook_url" text,
	"format" "notification_format" DEFAULT 'slack' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"notify_ticket_created" boolean DEFAULT true NOT NULL,
	"notify_pr_opened" boolean DEFAULT true NOT NULL,
	"notify_job_held" boolean DEFAULT true NOT NULL,
	"notify_job_failed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "notification_settings" ("id", "webhook_url", "format", "enabled", "notify_ticket_created", "notify_pr_opened", "notify_job_held", "notify_job_failed") VALUES
	(1, NULL, 'slack', true, true, true, true, true)
ON CONFLICT ("id") DO NOTHING;
