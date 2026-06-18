ALTER TYPE "public"."ticket_source" ADD VALUE 'slack';--> statement-breakpoint
ALTER TYPE "public"."ticket_source" ADD VALUE 'webhook';--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "slack_signing_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "slack_bot_token_encrypted" text;