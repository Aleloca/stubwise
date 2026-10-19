-- Chi ha chiesto cosa (piano 2026-10-19-mcp-collaboratori): autore del ticket e
-- richiedenti delle voci di backlog. Solo additivo, nessun enum toccato.
ALTER TABLE "tickets" ADD COLUMN "requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "backlog_item_requesters" (
	"item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlog_item_requesters_item_id_user_id_pk" PRIMARY KEY("item_id","user_id")
);--> statement-breakpoint
ALTER TABLE "backlog_item_requesters" ADD CONSTRAINT "backlog_item_requesters_item_id_backlog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_item_requesters" ADD CONSTRAINT "backlog_item_requesters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backlog_item_requesters_user_id_idx" ON "backlog_item_requesters" USING btree ("user_id");
