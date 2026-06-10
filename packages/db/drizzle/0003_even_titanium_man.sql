ALTER TYPE "public"."comment_author_type" ADD VALUE 'system';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "webhook_secret" text DEFAULT '' NOT NULL;