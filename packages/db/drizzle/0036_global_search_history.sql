-- Ricerca globale (spotlight Cmd/K): cronologia UNIFICATA. Migrazione SCRITTA A
-- MANO per PRESERVARE I DATI: generalizza `doc_search_history` (solo pagine doc)
-- in `search_history` (poliforma: ticket/progetto/repository/doc). Le righe Docs
-- esistenti migrano come `type='doc'` e la vecchia tabella viene droppata.

-- Enum dei tipi cercabili nella cronologia globale.
CREATE TYPE "public"."search_entity" AS ENUM('ticket', 'project', 'repository', 'doc');--> statement-breakpoint

-- Nuova tabella unificata. `repository_id` è nullable con FK set null (solo le
-- voci Docs lo valorizzano, per filtrare i recenti in scope "questa doc").
CREATE TABLE "search_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "public"."search_entity" NOT NULL,
	"entity_id" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"route" text NOT NULL,
	"repository_id" uuid,
	"clicked_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "search_history" ADD CONSTRAINT "search_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_history" ADD CONSTRAINT "search_history_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_history_user_type_entity_unique" ON "search_history" USING btree ("user_id","type","entity_id");--> statement-breakpoint
CREATE INDEX "search_history_recent_idx" ON "search_history" USING btree ("user_id","clicked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "search_history_repo_recent_idx" ON "search_history" USING btree ("user_id","repository_id","clicked_at" DESC NULLS LAST);--> statement-breakpoint

-- Migrazione dati Docs → search_history (type='doc'). L'identità di una pagina
-- doc è (repository_id, slug), quindi:
--   entity_id = repository_id::text || ':' || slug     (id poliforma della doc)
--   subtitle  = kind (technical/functional/manual/releases)
--   route     = /docs/<repository_id>/<slug>          (dove naviga la palette)
--   repository_id conservato (filtro dei recenti in scope Docs)
--   clicked_at conservato (ordine cronologico invariato)
-- L'unique (user_id, 'doc', entity_id) è garantita: la vecchia unique era su
-- (user_id, repository_id, slug), da cui entity_id = repository_id:slug è unico
-- per lo stesso utente. Nessun rischio di conflitto.
INSERT INTO "search_history" ("user_id", "type", "entity_id", "title", "subtitle", "route", "repository_id", "clicked_at")
SELECT
	h."user_id",
	'doc'::"public"."search_entity",
	h."repository_id"::text || ':' || h."slug",
	h."title",
	h."kind"::text,
	'/docs/' || h."repository_id"::text || '/' || h."slug",
	h."repository_id",
	h."clicked_at"
FROM "doc_search_history" h;--> statement-breakpoint

-- Vecchia tabella non più necessaria (le sue FK e i suoi indici cadono con essa).
DROP TABLE "doc_search_history";
