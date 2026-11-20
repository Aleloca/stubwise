-- Area 11, F1: la documentazione di prodotto — lo spazio e l'editor. Le
-- pagine (corpo a blocchi in jsonb, D-11 = a; `rev_seq` la sequenza delle
-- revisioni della pagina; gli id dei blocchi già dati in
-- `product_page_block_ids`, perché non si riusino mai), le
-- revisioni (create, edit, rename, move: le scritture della stessa sessione
-- si uniscono all'ultima revisione della pagina, se è sua), chi segue, le
-- immagini caricate (D-3 = a), e la serie dei codici `-D` condivisa coi Docs
-- dei repository (D-9 = a): `doc_page_codes` accetta le pagine di prodotto,
-- numerate sotto lo STESSO lock e dalla stessa sequenza per progetto.
CREATE TABLE "product_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"parent_id" uuid REFERENCES "product_pages"("id"),
	"order" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rev_seq" integer DEFAULT 0 NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_pages_not_own_parent_chk" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);
--> statement-breakpoint
CREATE INDEX "product_pages_tree_idx" ON "product_pages" ("project_id", "parent_id", "order");
--> statement-breakpoint
CREATE TABLE "product_page_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL REFERENCES "product_pages"("id") ON DELETE CASCADE,
	"session_id" text,
	"seq" integer NOT NULL,
	"last_seq" integer NOT NULL,
	"actor_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"kind" text DEFAULT 'edit' NOT NULL,
	"undo_of" uuid REFERENCES "product_page_revisions"("id") ON DELETE SET NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" jsonb,
	"parent" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_page_revisions_kind_chk" CHECK ("kind" in ('create','edit','rename','move'))
);
--> statement-breakpoint
CREATE INDEX "product_page_revisions_page_seq_idx" ON "product_page_revisions" ("page_id", "last_seq");
--> statement-breakpoint
-- Gli id (blocco, riga, cella) già dati in una pagina: li genera il client
-- (`blk-<uuid>`, il prototipo), e un id non torna per un blocco diverso.
-- `removed_by`/`removed_session`: chi e quale sessione dell'editor l'ha tolto
-- per ultima, perché ⌘Z di quella sessione lo possa rimettere.
CREATE TABLE "product_page_block_ids" (
	"page_id" uuid NOT NULL REFERENCES "product_pages"("id") ON DELETE CASCADE,
	"block_id" text NOT NULL,
	"removed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"removed_session" text,
	CONSTRAINT "product_page_block_ids_pk" PRIMARY KEY ("page_id", "block_id")
);
--> statement-breakpoint
CREATE TABLE "product_page_follows" (
	"page_id" uuid NOT NULL REFERENCES "product_pages"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_page_follows_pk" PRIMARY KEY ("page_id", "user_id")
);
--> statement-breakpoint
CREATE TABLE "product_page_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL REFERENCES "product_pages"("id") ON DELETE CASCADE,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"storage_key" text NOT NULL UNIQUE,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- La serie `-D` condivisa (D-9 = a). Una riga è di un repository (repository
-- e slug insieme) o di una pagina di prodotto (né repository né slug). Il
-- riferimento alla pagina si azzera quando la pagina se ne va: il numero
-- resta preso, e non si riusa.
ALTER TABLE "doc_page_codes" ALTER COLUMN "repository_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "doc_page_codes" ALTER COLUMN "slug" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "doc_page_codes" ADD COLUMN "product_page_id" uuid REFERENCES "product_pages"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "doc_page_codes" ADD CONSTRAINT "doc_page_codes_owner_chk" CHECK (("repository_id" IS NULL) = ("slug" IS NULL) AND NOT ("repository_id" IS NOT NULL AND "product_page_id" IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX "doc_page_codes_product_page_idx" ON "doc_page_codes" ("product_page_id") WHERE "product_page_id" IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "stubwise_product_page_code"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- Lo stesso lock e la stessa sequenza per progetto di `stubwise_ensure_doc_page_codes` (0142).
	PERFORM pg_advisory_xact_lock(hashtext('stubwise-doc-code:' || NEW."project_id"::text));
	INSERT INTO "doc_page_codes" ("project_id", "number", "product_page_id")
	VALUES (
		NEW."project_id",
		coalesce((SELECT max("number") FROM "doc_page_codes" WHERE "project_id" = NEW."project_id"), 0) + 1,
		NEW."id"
	);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "product_pages_code" AFTER INSERT ON "product_pages"
	FOR EACH ROW EXECUTE FUNCTION "stubwise_product_page_code"();
