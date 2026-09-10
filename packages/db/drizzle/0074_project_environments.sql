-- Fase 8 — ambienti di progetto e la dimensione ambiente sulle variabili.
-- Additiva, nessun `ALTER TYPE`, un solo batch — ma CON BACKFILL: non è
-- cosmetica. In produzione ci sono repository con `.env` già popolati che la
-- pipeline di fix legge a ogni run (`loadProjectEnvFiles`); se restassero
-- senza ambiente, il fix smetterebbe di trovarli e i suoi test inizierebbero
-- a fallire per variabili mancanti.

-- Tabella nuova: l'anagrafica degli ambienti di un progetto (test/staging/
-- production). Un CHECK, non un pgEnum Postgres: stesso pattern di
-- `calendar_series.action` (fase 7b) per restare in un solo batch.
CREATE TABLE "project_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"url" text,
	"server_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_environments_kind_chk" CHECK ("kind" in ('test', 'staging', 'production'))
);
--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_environments_project_id_name_unique" ON "project_environments" USING btree ("project_id","name");--> statement-breakpoint

-- Backfill 1/2: un ambiente `test` per OGNI progetto esistente. Non
-- opt-in — è la destinazione di ogni file d'ambiente già configurato, e un
-- progetto senza il suo `test` lascerebbe quelle righe orfane al passo
-- successivo.
INSERT INTO "project_environments" ("project_id", "name", "kind")
SELECT "id", 'test', 'test' FROM "projects";
--> statement-breakpoint

-- La colonna nuova nasce NULLABLE: va riempita dal backfill 2/2 prima di
-- poter diventare NOT NULL (sotto). Il vecchio unique (repository, path) va
-- tolto PRIMA del nuovo, perché insistono sullo stesso repository_id/path e
-- il nuovo li estende con l'ambiente.
ALTER TABLE "project_env_files" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
DROP INDEX "project_env_files_project_id_path_unique";--> statement-breakpoint

-- Backfill 2/2: ogni riga esistente si collega all'ambiente `test` del
-- progetto DEL PROPRIO repository (project_env_files -> repositories ->
-- projects -> project_environments). Sono le 20 righe reali di produzione
-- citate dal design: senza questo UPDATE resterebbero con environment_id
-- NULL e il vincolo NOT NULL sotto fallirebbe l'intera migrazione.
UPDATE "project_env_files" AS "f"
SET "environment_id" = "e"."id"
FROM "repositories" AS "r"
JOIN "project_environments" AS "e"
  ON "e"."project_id" = "r"."project_id" AND "e"."kind" = 'test'
WHERE "r"."id" = "f"."repository_id";
--> statement-breakpoint

ALTER TABLE "project_env_files" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project_env_files" ADD CONSTRAINT "project_env_files_environment_id_project_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_env_files_repository_environment_path_unique" ON "project_env_files" USING btree ("repository_id","environment_id","path");
