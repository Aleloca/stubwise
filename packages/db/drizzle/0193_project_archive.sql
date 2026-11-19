-- Area 9, F6 (D-8): archivio ed eliminazione di un progetto.
-- Un progetto archiviato sparisce da ogni elenco e lettura (tranne quelle
-- dedicate agli archiviati) e il worker non ne prende lavoro; si riapre.
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "projects_archived_idx" ON "projects" USING btree ("id") WHERE archived_at IS NOT NULL;
--> statement-breakpoint
-- Eliminare un progetto STACCA i suoi repository (L-2): restano, senza
-- progetto, e li vede solo l'Amministrazione finché non si ricollegano.
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Il registro tiene l'id di un progetto eliminato (L-3): senza la FK le sue
-- voci non diventano «senza progetto» (le leggerebbe chi legge l'istanza).
-- L'eccezione del trigger per la SET NULL di `project_id` resta, e non
-- scatta più.
ALTER TABLE "change_log" DROP CONSTRAINT "change_log_project_id_projects_id_fk";
--> statement-breakpoint
-- Cosa resta di un progetto eliminato (D-8, R-G5 del prototipo): codice,
-- nome e chi ne era membro. Serve SOLO a dire «chi conosceva il progetto»
-- (l'etichetta di `project.deleted`, la provenienza di un repository
-- staccato); nessun altro dato del progetto sopravvive.
CREATE TABLE "deleted_projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deleted_project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "deleted_project_members_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "deleted_project_members" ADD CONSTRAINT "deleted_project_members_project_id_deleted_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."deleted_projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deleted_project_members" ADD CONSTRAINT "deleted_project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "deleted_project_members_user_idx" ON "deleted_project_members" USING btree ("user_id");
--> statement-breakpoint
-- Un repository staccato: quando e da quale progetto eliminato. Si azzerano
-- insieme quando si ricollega.
ALTER TABLE "repositories" ADD COLUMN "detached_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "detached_from_project_id" uuid;
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_detached_from_project_id_deleted_projects_id_fk" FOREIGN KEY ("detached_from_project_id") REFERENCES "public"."deleted_projects"("id") ON DELETE set null ON UPDATE no action;
