-- Area 6, F5b, review del server (punto 5): «torna con la ricollegazione»
-- valeva solo per una casella DISATTIVATA. Scollegare Google cancella la riga
-- di `google_accounts`, la FK mette a NULL `account_id`/`google_account_id`, e
-- ricollegando nasce un id nuovo: i riferimenti restavano orfani per sempre.
-- Si ricorda allora l'INDIRIZZO della casella accanto all'id: alla
-- ricollegazione dello stesso indirizzo da parte della stessa persona
-- (`reattachDriveReferences`, packages/db/src/drive-references.ts) i
-- riferimenti si riagganciano alla riga nuova.
ALTER TABLE "drive_folder_links" ADD COLUMN "account_email" text;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "google_account_email" text;
--> statement-breakpoint
UPDATE "drive_folder_links" AS l SET "account_email" = a."email" FROM "google_accounts" AS a WHERE a."id" = l."account_id";
--> statement-breakpoint
UPDATE "drive_files" AS f SET "google_account_email" = a."email" FROM "google_accounts" AS a WHERE a."id" = f."google_account_id";
--> statement-breakpoint
-- L'indirizzo lo scrive il DB, in UN posto, a ogni scrittura dell'id: nessun
-- chiamante (server, worker, riaggancio) deve ricordarsene. Quando la FK mette
-- l'id a NULL l'indirizzo resta: è proprio quello che serve dopo.
CREATE FUNCTION "drive_folder_links_remember_email"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."account_id" IS NOT NULL THEN
		NEW."account_email" := (SELECT "email" FROM "google_accounts" WHERE "id" = NEW."account_id");
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "drive_folder_links_account_email" BEFORE INSERT OR UPDATE OF "account_id" ON "drive_folder_links"
	FOR EACH ROW EXECUTE FUNCTION "drive_folder_links_remember_email"();
--> statement-breakpoint
CREATE FUNCTION "drive_files_remember_email"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."google_account_id" IS NOT NULL THEN
		NEW."google_account_email" := (SELECT "email" FROM "google_accounts" WHERE "id" = NEW."google_account_id");
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "drive_files_google_account_email" BEFORE INSERT OR UPDATE OF "google_account_id" ON "drive_files"
	FOR EACH ROW EXECUTE FUNCTION "drive_files_remember_email"();
