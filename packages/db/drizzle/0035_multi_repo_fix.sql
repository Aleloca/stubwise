-- Fix multi-repository (Fase 3). Migrazione SCRITTA A MANO per PRESERVARE I DATI.
-- Un ticket può toccare più repo dello stesso progetto: numerazione e ingestion
-- salgono dal repo al PROGETTO (oggi 1 repo/progetto → i valori coincidono e la
-- migrazione è 1:1), gli errorGroups diventano per-progetto, tickets.repository_id
-- è rimosso (il legame ticket↔repo vive ora solo in ticket_repositories).

-- 1) Numerazione ticket per-PROGETTO. Oggi c'è 1 repo per progetto, quindi il
--    numero coincide col contatore del suo unico repo (MAX per robustezza).
ALTER TABLE "projects" ADD COLUMN "next_ticket_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "projects" p SET "next_ticket_number" = sub.n FROM (
	SELECT r."project_id" AS pid, MAX(r."next_ticket_number") AS n
	FROM "repositories" r GROUP BY r."project_id"
) sub WHERE p."id" = sub.pid;--> statement-breakpoint
ALTER TABLE "repositories" DROP COLUMN "next_ticket_number";--> statement-breakpoint

-- 2) ingestion_key sale al progetto (migrata identica dal repo 1:1 al suo
--    progetto: gli SDK già installati continuano a funzionare senza modifiche).
ALTER TABLE "projects" ADD COLUMN "ingestion_key" text;--> statement-breakpoint
UPDATE "projects" p SET "ingestion_key" = r."ingestion_key"
	FROM "repositories" r WHERE r."project_id" = p."id";--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "ingestion_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_ingestion_key_unique" UNIQUE("ingestion_key");--> statement-breakpoint
-- La unique del repo (repositories_ingestion_key_unique) cade col DROP COLUMN.
ALTER TABLE "repositories" DROP COLUMN "ingestion_key";--> statement-breakpoint

-- 3) error_groups per-PROGETTO (D8): aggiungi project_id, popolalo dal progetto
--    del repo, rendilo NOT NULL + FK, ricrea l'unique del fingerprint per
--    progetto e droppa repository_id. NB: l'unique è un INDICE (era stato creato
--    con CREATE UNIQUE INDEX in 0000 e MAI rinominato in 0033, quando la colonna
--    passò da project_id a repository_id): il nome reale in DB è quindi
--    "error_groups_project_id_fingerprint_unique" su (repository_id, fingerprint).
--    Lo droppo come INDEX e lo ricreo, stavolta sul nuovo project_id.
ALTER TABLE "error_groups" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "error_groups" eg SET "project_id" = r."project_id"
	FROM "repositories" r WHERE r."id" = eg."repository_id";--> statement-breakpoint
ALTER TABLE "error_groups" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "error_groups_project_id_fingerprint_unique";--> statement-breakpoint
-- La FK error_groups_repository_id_repositories_id_fk cade col DROP COLUMN.
ALTER TABLE "error_groups" DROP COLUMN "repository_id";--> statement-breakpoint
CREATE UNIQUE INDEX "error_groups_project_id_fingerprint_unique" ON "error_groups" USING btree ("project_id","fingerprint");--> statement-breakpoint

-- 4) tickets: rimuovi repository_id (D9). Il ticket appartiene solo al progetto;
--    non esistono indici di tickets che nominano repository_id (solo la FK
--    tickets_repository_id_repositories_id_fk, che cade col DROP COLUMN).
ALTER TABLE "tickets" DROP COLUMN "repository_id";--> statement-breakpoint

-- 5) Stato PR per-repo di un ticket (nuova tabella + enum): una riga per ogni
--    repo modificato dal fix, popolata dopo l'esecuzione dell'agente.
CREATE TYPE "public"."pr_state" AS ENUM('open', 'merged', 'closed_unmerged');--> statement-breakpoint
CREATE TABLE "ticket_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"pr_url" text,
	"pr_state" "public"."pr_state" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "ticket_repositories" ADD CONSTRAINT "ticket_repositories_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_repositories" ADD CONSTRAINT "ticket_repositories_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_repositories_ticket_id_repository_id_unique" ON "ticket_repositories" USING btree ("ticket_id","repository_id");--> statement-breakpoint
CREATE INDEX "ticket_repositories_ticket_id_idx" ON "ticket_repositories" USING btree ("ticket_id");
