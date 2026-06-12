ALTER TYPE "public"."ai_job_status" ADD VALUE 'held' BEFORE 'pr_opened';--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"type" "ticket_type" PRIMARY KEY NOT NULL,
	"auto_fix" boolean DEFAULT true NOT NULL,
	"max_effort" integer DEFAULT 3 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "manual_trigger" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "effort" integer;--> statement-breakpoint
INSERT INTO "automation_rules" ("type", "auto_fix", "max_effort") VALUES
	('bug', true, 3),
	('task', true, 2),
	('feature', false, 3),
	('feedback', false, 3)
ON CONFLICT ("type") DO NOTHING;