-- Quota degli account (design 2026-10-15 §4): «al limite fino a» per provider e
-- «solo questo account» per progetto. Additiva.
ALTER TABLE "ai_providers" ADD COLUMN "limited_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ai_provider_exclusive" boolean DEFAULT false NOT NULL;
