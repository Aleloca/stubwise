-- Review della fetta 2 dell'area 5 (11 nov 2026): gli oggetti dello storage
-- rimasti SENZA riga. Un caricamento interrotto o troppo grande, un insert
-- fallito, una copia a metà: il server prova a togliere l'oggetto subito, e se
-- lo storage rifiuta la chiave finisce qui invece di perdersi. La pulizia
-- oraria del server (`purgeDeletedDriveObjects`) la ritenta e la toglie.
CREATE TABLE "storage_orphans" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_orphans_reason_chk" CHECK ("reason" <> '')
);
--> statement-breakpoint
CREATE INDEX "storage_orphans_created_at_idx" ON "storage_orphans" USING btree ("created_at");
