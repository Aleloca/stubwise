-- Integrazione area 2, fetta 4 (9 nov 2026): modello, moduli e cliente di un
-- progetto. I progetti esistenti diventano Software con tutti e quattro i
-- moduli, interni (decisione del maintainer). Un progetto «commessa» è quello
-- con un cliente (`kind` si deriva da `client_name`, non si salva).
-- Testo con CHECK, non enum: un modello o un modulo nuovo è una migrazione
-- semplice, senza `ADD VALUE`.
ALTER TABLE "projects" ADD COLUMN "client_name" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "template" text DEFAULT 'software' NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "modules" text[] DEFAULT '{docs,releases,support,servers}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_template_chk"
	CHECK ("template" IN ('software', 'marketing', 'client', 'empty'));
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_modules_chk"
	CHECK ("modules" <@ ARRAY['docs', 'releases', 'support', 'servers']::text[]);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_name_chk"
	CHECK ("client_name" IS NULL OR length(btrim("client_name")) BETWEEN 1 AND 120);
