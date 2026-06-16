ALTER TABLE "automation_rules" ADD COLUMN "max_cost_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "monthly_budget_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "notify_budget_held" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "test_command" text;