-- Area 11, F3: i passaggi delle pagine di prodotto con l'embedding (bge-m3,
-- 1024), come `doc_chunks` ma in una tabella a parte: `doc_chunks` è legata ai
-- repository. `embedded_at` è l'`updated_at` della versione che ha i chunk di
-- adesso: il poller del server rifà le pagine con `embedded_at < updated_at`.
ALTER TABLE "product_pages" ADD COLUMN "embedded_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "product_page_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL REFERENCES "product_pages"("id") ON DELETE CASCADE,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"position" integer NOT NULL,
	"heading" text,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"token_count" integer
);
--> statement-breakpoint
CREATE INDEX "product_page_chunks_page_idx" ON "product_page_chunks" USING btree ("page_id");
--> statement-breakpoint
CREATE INDEX "product_page_chunks_project_idx" ON "product_page_chunks" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "product_page_chunks_embedding_idx" ON "product_page_chunks" USING hnsw ("embedding" vector_cosine_ops);
