CREATE TYPE "public"."ticket_link_kind" AS ENUM('blocks', 'relates_to', 'parent');--> statement-breakpoint
ALTER TYPE "public"."ticket_event_kind" ADD VALUE 'relation_added';--> statement-breakpoint
ALTER TYPE "public"."ticket_event_kind" ADD VALUE 'relation_removed';--> statement-breakpoint
CREATE TABLE "ticket_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_ticket_id" uuid NOT NULL,
	"target_ticket_id" uuid NOT NULL,
	"kind" "ticket_link_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_source_ticket_id_tickets_id_fk" FOREIGN KEY ("source_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_links" ADD CONSTRAINT "ticket_links_target_ticket_id_tickets_id_fk" FOREIGN KEY ("target_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_links_source_target_kind_unique" ON "ticket_links" USING btree ("source_ticket_id","target_ticket_id","kind");--> statement-breakpoint
CREATE INDEX "ticket_links_source_idx" ON "ticket_links" USING btree ("source_ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_links_target_idx" ON "ticket_links" USING btree ("target_ticket_id");