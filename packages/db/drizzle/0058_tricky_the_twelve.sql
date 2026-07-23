ALTER TABLE "backlog_items" ADD COLUMN "implementation_plan" text;--> statement-breakpoint
ALTER TABLE "backlog_items" ADD COLUMN "origin_content" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "implementation_plan" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "origin_content" text;