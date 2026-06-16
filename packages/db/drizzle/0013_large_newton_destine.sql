CREATE TYPE "public"."language" AS ENUM('en', 'it');--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"content_language" "language" DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "language" "language" DEFAULT 'en' NOT NULL;--> statement-breakpoint
INSERT INTO "instance_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;