ALTER TABLE "doc_pages" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_pages" ADD COLUMN "significant" boolean;