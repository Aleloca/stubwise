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
