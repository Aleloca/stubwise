ALTER TYPE "public"."ticket_source" ADD VALUE 'widget';--> statement-breakpoint
CREATE TABLE "widget_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"external_user_email" text,
	"external_user_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widget_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb,
	"ticket_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widget_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_repository_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text DEFAULT 'Assistenza' NOT NULL,
	"welcome_message" text DEFAULT 'Ciao! Come posso aiutarti?' NOT NULL,
	"accent_color" text DEFAULT '#22c55e' NOT NULL,
	"language" text DEFAULT 'it' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "widget_conversations" ADD CONSTRAINT "widget_conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_messages" ADD CONSTRAINT "widget_messages_conversation_id_widget_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."widget_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_messages" ADD CONSTRAINT "widget_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_settings" ADD CONSTRAINT "widget_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "widget_conversations_project_idx" ON "widget_conversations" USING btree ("project_id","last_message_at");--> statement-breakpoint
CREATE INDEX "widget_messages_conversation_idx" ON "widget_messages" USING btree ("conversation_id");