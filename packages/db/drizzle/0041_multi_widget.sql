CREATE TABLE "widgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_repository_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text DEFAULT 'Assistenza' NOT NULL,
	"welcome_message" text DEFAULT 'Ciao! Come posso aiutarti?' NOT NULL,
	"accent_color" text DEFAULT '#22c55e' NOT NULL,
	"language" text DEFAULT 'it' NOT NULL,
	"daily_message_cap" integer,
	"daily_ticket_cap" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "widgets_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "widgets_project_idx" ON "widgets" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "widget_conversations" ADD COLUMN "widget_id" uuid;--> statement-breakpoint
ALTER TABLE "widget_conversations" ADD CONSTRAINT "widget_conversations_widget_id_widgets_id_fk" FOREIGN KEY ("widget_id") REFERENCES "public"."widgets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "widgets" ("project_id", "name", "key", "enabled", "enabled_repository_ids", "title", "welcome_message", "accent_color", "language")
SELECT "project_id", 'Widget', replace(gen_random_uuid()::text, '-', ''), "enabled", "enabled_repository_ids", "title", "welcome_message", "accent_color", "language"
FROM "widget_settings";--> statement-breakpoint
UPDATE "widget_conversations" c SET "widget_id" = w."id" FROM "widgets" w WHERE w."project_id" = c."project_id";--> statement-breakpoint
DROP TABLE "widget_settings" CASCADE;
