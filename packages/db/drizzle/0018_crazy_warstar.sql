CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"comment_id" uuid,
	"uploader_id" uuid,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "s3_endpoint" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "s3_region" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "s3_bucket" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "s3_access_key" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "s3_secret_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_ticket_id_created_at_idx" ON "attachments" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "attachments_comment_id_idx" ON "attachments" USING btree ("comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_storage_key_unique" ON "attachments" USING btree ("storage_key");