-- Area 9, F5 (I2): la chiave d'ingestione non esce più intera da nessuna
-- lettura (solo dalla rigenerazione, una volta). L'Integrazione ne mostra le
-- ultime 4, QUANDO è stata fatta e DA CHI: si scrivono alla creazione del
-- progetto e a ogni rigenerazione; null per le chiavi di prima.
ALTER TABLE "projects" ADD COLUMN "ingestion_key_created_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ingestion_key_created_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_ingestion_key_created_by_user_id_users_id_fk" FOREIGN KEY ("ingestion_key_created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
