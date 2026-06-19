CREATE TYPE "public"."ai_provider_test_status" AS ENUM('idle', 'pending', 'passed', 'failed');--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN "test_status" "ai_provider_test_status" DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN "test_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN "test_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD COLUMN "test_error" text;