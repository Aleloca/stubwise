-- Area 11, F2: i commenti delle pagine di prodotto. «Frase eliminata» non è
-- una colonna (si deriva dai blocchi di adesso); un commento eliminato non ha
-- più testo (CHECK, come `comments` dei ticket, 0084). La frase citata (una
-- riga, ≤ 200 caratteri) la tiene `cleanQuote` nel server, non una CHECK:
-- `char_length` conta i byte in un database SQL_ASCII (quello dei test), e
-- «…» farebbe fallire una frase giusta.
CREATE TABLE "product_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL REFERENCES "product_pages"("id") ON DELETE CASCADE,
	"anchor_id" text NOT NULL,
	"quote" text NOT NULL,
	"reply_to_id" uuid REFERENCES "product_comments"("id") ON DELETE CASCADE,
	"body" text NOT NULL,
	"author_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"mentions" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_comments_deleted_body_empty_chk" CHECK ("deleted_at" IS NULL OR "body" = '')
);
--> statement-breakpoint
CREATE INDEX "product_comments_page_idx" ON "product_comments" ("page_id", "created_at");
