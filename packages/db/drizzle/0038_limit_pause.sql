CREATE TYPE "public"."held_reason" AS ENUM('limit', 'budget', 'other');--> statement-breakpoint
ALTER TYPE "public"."doc_generation_status" ADD VALUE 'paused' BEFORE 'succeeded';--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "held_reason" "held_reason";--> statement-breakpoint
ALTER TABLE "doc_generation_jobs" ADD COLUMN "held_reason" "held_reason";--> statement-breakpoint
ALTER TABLE "doc_generations" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doc_generations" ADD COLUMN "pause_reason" text;