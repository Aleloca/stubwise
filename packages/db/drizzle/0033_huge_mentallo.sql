-- Modello a due livelli repository/progetto. Migrazione SCRITTA A MANO per
-- PRESERVARE I DATI: l'attuale `projects` (= repo) diventa `repositories`; nasce
-- una nuova entità `projects` (gruppo, 1:N). Mappa repo→progetto deterministica
-- 1:1 sullo slug (unico). NON è un drop+add: rename di tabella/colonne/vincoli +
-- UPDATE deterministici. Ogni repository finisce con un project_id; ogni
-- ticket/milestone con project_id valorizzato.

-- 1) Rinomina la tabella projects -> repositories (gli id restano: le FK delle
--    tabelle repository-level che puntavano a projects.id puntano già al repo).
ALTER TABLE "projects" RENAME TO "repositories";--> statement-breakpoint
-- Allinea i nomi di vincoli/indici al nuovo nome tabella (così future
-- generazioni drizzle non vanno in drift: lo snapshot li nomina repositories_*).
ALTER TABLE "repositories" RENAME CONSTRAINT "projects_pkey" TO "repositories_pkey";--> statement-breakpoint
ALTER TABLE "repositories" RENAME CONSTRAINT "projects_slug_unique" TO "repositories_slug_unique";--> statement-breakpoint
ALTER TABLE "repositories" RENAME CONSTRAINT "projects_ingestion_key_unique" TO "repositories_ingestion_key_unique";--> statement-breakpoint
ALTER TABLE "repositories" RENAME CONSTRAINT "projects_git_account_id_git_accounts_id_fk" TO "repositories_git_account_id_git_accounts_id_fk";--> statement-breakpoint

-- 2) Nuova entità progetto (gruppo). Le impostazioni di prodotto (ai_provider_id,
--    doc_auto_update) salgono qui dal repository.
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"ai_provider_id" uuid,
	"doc_auto_update" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_ai_provider_id_ai_providers_id_fk" FOREIGN KEY ("ai_provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- 3) Collega ogni repository al suo progetto-wrapper (1:1 su slug, unico).
ALTER TABLE "repositories" ADD COLUMN "project_id" uuid;--> statement-breakpoint
WITH np AS (
	INSERT INTO "projects" ("name", "slug", "ai_provider_id", "doc_auto_update", "created_at")
	SELECT r."name", r."slug", r."ai_provider_id", r."doc_auto_update", r."created_at"
	FROM "repositories" r
	RETURNING "id", "slug"
)
UPDATE "repositories" r SET "project_id" = np."id" FROM np WHERE np."slug" = r."slug";--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Le impostazioni di prodotto ora vivono sul progetto: rimuovile dal repository.
ALTER TABLE "repositories" DROP COLUMN "ai_provider_id";--> statement-breakpoint
ALTER TABLE "repositories" DROP COLUMN "doc_auto_update";--> statement-breakpoint

-- 4) Tabelle repository-level: rinomina la colonna FK project_id -> repository_id
--    (i dati puntano già al repo dopo il rename della tabella) e allinea il nome
--    del vincolo FK al nuovo nome (<t>_repository_id_repositories_id_fk).
ALTER TABLE "error_groups" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "error_groups" RENAME CONSTRAINT "error_groups_project_id_projects_id_fk" TO "error_groups_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "project_env_files" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "project_env_files" RENAME CONSTRAINT "project_env_files_project_id_projects_id_fk" TO "project_env_files_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "doc_generations" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "doc_generations" RENAME CONSTRAINT "doc_generations_project_id_projects_id_fk" TO "doc_generations_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "doc_generation_jobs" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "doc_generation_jobs" RENAME CONSTRAINT "doc_generation_jobs_project_id_projects_id_fk" TO "doc_generation_jobs_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "doc_auto_update_jobs" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "doc_auto_update_jobs" RENAME CONSTRAINT "doc_auto_update_jobs_project_id_projects_id_fk" TO "doc_auto_update_jobs_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "doc_pages" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "doc_pages" RENAME CONSTRAINT "doc_pages_project_id_projects_id_fk" TO "doc_pages_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "doc_chunks" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "doc_chunks" RENAME CONSTRAINT "doc_chunks_project_id_projects_id_fk" TO "doc_chunks_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "doc_nodes" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "doc_nodes" RENAME CONSTRAINT "doc_nodes_project_id_projects_id_fk" TO "doc_nodes_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "doc_chat_sessions" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "doc_chat_sessions" RENAME CONSTRAINT "doc_chat_sessions_project_id_projects_id_fk" TO "doc_chat_sessions_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "doc_search_history" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "doc_search_history" RENAME CONSTRAINT "doc_search_history_project_id_projects_id_fk" TO "doc_search_history_repository_id_repositories_id_fk";--> statement-breakpoint

-- 5) Product-level: tickets/milestones. Rinomina project_id -> repository_id (il
--    repo bersaglio: era il vecchio project_id) e aggiungi un nuovo project_id
--    (gruppo) valorizzato col progetto-wrapper del repo.
-- tickets: repository_id resta NULLABLE (pronto per Fase 3), ma valorizzato.
ALTER TABLE "tickets" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "tickets" RENAME CONSTRAINT "tickets_project_id_projects_id_fk" TO "tickets_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "repository_id" DROP NOT NULL;--> statement-breakpoint
-- Gli indici (project_id, …) erano sul vecchio project_id (= repo): vanno ora
-- ricreati sul NUOVO project_id (gruppo). Droppali prima di aggiungere la colonna.
DROP INDEX "tickets_project_id_number_unique";--> statement-breakpoint
DROP INDEX "tickets_project_id_status_idx";--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "tickets" t SET "project_id" = r."project_id" FROM "repositories" r WHERE r."id" = t."repository_id";--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_project_id_number_unique" ON "tickets" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "tickets_project_id_status_idx" ON "tickets" USING btree ("project_id","status");--> statement-breakpoint

ALTER TABLE "milestones" RENAME COLUMN "project_id" TO "repository_id";--> statement-breakpoint
ALTER TABLE "milestones" RENAME CONSTRAINT "milestones_project_id_projects_id_fk" TO "milestones_repository_id_repositories_id_fk";--> statement-breakpoint
-- Idem milestones: gli indici (project_id, …) vanno ricreati sul nuovo gruppo.
DROP INDEX "milestones_project_id_idx";--> statement-breakpoint
DROP INDEX "milestones_project_id_name_unique";--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "milestones" m SET "project_id" = r."project_id" FROM "repositories" r WHERE r."id" = m."repository_id";--> statement-breakpoint
ALTER TABLE "milestones" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "milestones_project_id_idx" ON "milestones" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_project_id_name_unique" ON "milestones" USING btree ("project_id","name");
