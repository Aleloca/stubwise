CREATE TYPE "public"."ai_provider_kind" AS ENUM('api_key', 'account');--> statement-breakpoint
CREATE TYPE "public"."ai_usage_source" AS ENUM('deterministic', 'llm_fallback');--> statement-breakpoint
CREATE TABLE "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" integer NOT NULL,
	"kind" "ai_provider_kind" NOT NULL,
	"label" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_remaining" jsonb,
	"weekly_remaining" jsonb,
	"session_reset_at" timestamp with time zone,
	"weekly_reset_at" timestamp with time zone,
	"source" "ai_usage_source" NOT NULL,
	"parse_ok" boolean NOT NULL,
	"raw_text" text
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_usage_snapshots" ADD CONSTRAINT "ai_usage_snapshots_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_snapshots_provider_id_captured_at_idx" ON "ai_usage_snapshots" USING btree ("provider_id","captured_at");--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;