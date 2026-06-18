ALTER TABLE "invites" ADD COLUMN "slack_user_id" text;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "slack_avatar_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "slack_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "slack_avatar_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_slack_user_id_unique" UNIQUE("slack_user_id");