-- Area 11, F4: le sezioni prese di una pagina di prodotto (chi scrive, fino a
-- quando). In tabella perché il worker (F5) deve vederle; presenza e cursori
-- restano nella memoria del server. Scadono da sole (`expires_at`).
CREATE TABLE "product_section_holds" (
	"page_id" uuid NOT NULL REFERENCES "product_pages"("id") ON DELETE CASCADE,
	"section_id" text NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "product_section_holds_pk" PRIMARY KEY ("page_id", "section_id")
);
