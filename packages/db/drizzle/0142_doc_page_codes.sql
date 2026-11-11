-- Area 5, Docs, fetta 1 (11 nov 2026): i codici `<PRJ>-D<n>` delle pagine,
-- stabili alle rigenerazioni (D2 = a). Piano in
-- `docs/plans/2026-11-11-integrazione-area5-fetta1-plan.md`.
--
-- Un codice per (repository, slug), numerato per PROGETTO e mai riusato. Una
-- rigenerazione inserisce righe nuove con gli stessi slug: il codice resta.
-- Una pagina manuale e una generata con lo stesso slug nello stesso repository
-- condividono il codice, e si risolve come la rotta della pagina (prima la
-- generata). Le note di rilascio non hanno codice: nel prototipo non sono
-- pagine.
CREATE TABLE "doc_page_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"repository_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_page_codes" ADD CONSTRAINT "doc_page_codes_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "doc_page_codes" ADD CONSTRAINT "doc_page_codes_repository_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "doc_page_codes_project_number_idx" ON "doc_page_codes" USING btree ("project_id", "number");
--> statement-breakpoint
CREATE UNIQUE INDEX "doc_page_codes_repository_slug_idx" ON "doc_page_codes" USING btree ("repository_id", "slug");
--> statement-breakpoint
-- Il codice di (repository, slug) che non ce l'ha: il numero dopo l'ultimo del
-- progetto, sotto un lock per progetto (due scrittori dello stesso progetto si
-- mettono in fila qui). Il lock vale fino alla fine della transazione che
-- chiama: per questo gli scrittori LUNGHI (generazione completa, giro notturno,
-- embedding compresi) la chiamano PRIMA, in una transazione breve e sua
-- (`ensureDocPageCodes` di `@stubwise/db`), e nella loro il trigger trova i
-- codici e non prende il lock. Senza, una pagina manuale nuova dello stesso
-- progetto resterebbe in fila per minuti (review della fetta 1).
CREATE FUNCTION "stubwise_ensure_doc_page_codes"(repository uuid, slugs text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
	project uuid;
	missing text[];
BEGIN
	SELECT coalesce(array_agg(s ORDER BY ord), '{}') INTO missing
	FROM (SELECT DISTINCT ON (s) s, ord FROM unnest(slugs) WITH ORDINALITY AS u(s, ord) ORDER BY s, ord) d
	WHERE NOT EXISTS (SELECT 1 FROM "doc_page_codes" c WHERE c."repository_id" = repository AND c."slug" = d.s);
	IF cardinality(missing) = 0 THEN
		RETURN;
	END IF;
	SELECT "project_id" INTO project FROM "repositories" WHERE "id" = repository;
	PERFORM pg_advisory_xact_lock(hashtext('stubwise-doc-code:' || project::text));
	INSERT INTO "doc_page_codes" ("project_id", "number", "repository_id", "slug")
	SELECT project,
		coalesce((SELECT max("number") FROM "doc_page_codes" WHERE "project_id" = project), 0) + row_number() OVER (ORDER BY m.ord),
		repository,
		m.s
	FROM unnest(missing) WITH ORDINALITY AS m(s, ord)
	WHERE NOT EXISTS (SELECT 1 FROM "doc_page_codes" c WHERE c."repository_id" = repository AND c."slug" = m.s)
	ON CONFLICT ("repository_id", "slug") DO NOTHING;
END;
$$;
--> statement-breakpoint
-- Il trigger copre ogni scrittore (pagine manuali comprese): una pagina nuova
-- che non sia una nota di rilascio prende il suo codice, se non ce l'ha già.
CREATE FUNCTION "stubwise_doc_page_code"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."kind" = 'releases' THEN
		RETURN NULL;
	END IF;
	PERFORM "stubwise_ensure_doc_page_codes"(NEW."repository_id", ARRAY[NEW."slug"]);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "doc_pages_code" AFTER INSERT ON "doc_pages"
	FOR EACH ROW EXECUTE FUNCTION "stubwise_doc_page_code"();
--> statement-breakpoint
-- Il backfill: un codice alle pagine VISIBILI di oggi (generazione corrente
-- più quelle senza generazione), per progetto, nell'ordine repository (nome),
-- tipo, posizione, data. Idempotente: salta le coppie che hanno già un codice.
CREATE FUNCTION "stubwise_backfill_doc_page_codes"() RETURNS void LANGUAGE sql AS $$
	WITH visible AS (
		SELECT DISTINCT ON (p."repository_id", p."slug")
			p."repository_id", p."slug", r."project_id", r."name",
			CASE p."kind" WHEN 'technical' THEN 0 WHEN 'functional' THEN 1 WHEN 'product' THEN 2 ELSE 3 END AS kind_order,
			p."position", p."created_at"
		FROM "doc_pages" p
		JOIN "repositories" r ON r."id" = p."repository_id"
		WHERE p."kind" <> 'releases'
			AND (p."generation_id" IS NULL OR p."generation_id" = r."current_doc_generation_id")
			AND NOT EXISTS (
				SELECT 1 FROM "doc_page_codes" c WHERE c."repository_id" = p."repository_id" AND c."slug" = p."slug"
			)
		ORDER BY p."repository_id", p."slug", (p."generation_id" IS NULL), p."created_at"
	),
	numbered AS (
		SELECT v.*,
			row_number() OVER (
				PARTITION BY v."project_id"
				ORDER BY v."name", v."repository_id", v.kind_order, v."position", v."created_at", v."slug"
			) + coalesce((SELECT max(c."number") FROM "doc_page_codes" c WHERE c."project_id" = v."project_id"), 0) AS "number"
		FROM visible v
	)
	INSERT INTO "doc_page_codes" ("project_id", "number", "repository_id", "slug")
	SELECT "project_id", "number", "repository_id", "slug" FROM numbered
	ON CONFLICT DO NOTHING;
$$;
--> statement-breakpoint
-- Le citazioni `doc` della Chat puntano al CODICE, non alla pagina (che cambia
-- id a ogni rigenerazione). Idempotente: una citazione che punta già a un
-- codice resta; una di una pagina che non c'è più se ne va, come a lettura.
CREATE FUNCTION "stubwise_doc_citations_to_codes"() RETURNS void LANGUAGE sql AS $$
	INSERT INTO "chat_message_citations" ("message_id", "kind", "ref_id", "position")
	SELECT cmc."message_id", 'doc', c."id", min(cmc."position")
	FROM "chat_message_citations" cmc
	JOIN "doc_pages" p ON p."id" = cmc."ref_id"
	JOIN "doc_page_codes" c ON c."repository_id" = p."repository_id" AND c."slug" = p."slug"
	WHERE cmc."kind" = 'doc'
	GROUP BY cmc."message_id", c."id"
	ON CONFLICT DO NOTHING;
	DELETE FROM "chat_message_citations" cmc
	WHERE cmc."kind" = 'doc'
		AND NOT EXISTS (SELECT 1 FROM "doc_page_codes" c WHERE c."id" = cmc."ref_id");
$$;
--> statement-breakpoint
SELECT "stubwise_backfill_doc_page_codes"();
--> statement-breakpoint
SELECT "stubwise_doc_citations_to_codes"();
