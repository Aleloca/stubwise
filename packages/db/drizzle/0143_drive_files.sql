-- Area 5, il Drive dei progetti, fetta 2 (11 nov 2026): i file CARICATI.
-- Piano in `docs/plans/2026-11-11-integrazione-area5-fetta2-plan.md`; decisioni
-- D3 = a (permessi come il prototipo), D4 = a (100 MB, i tipi della Chat), D1 = a
-- (niente Google: la sorgente `google` arriva con l'area 6).
--
-- Un file del Drive: il codice `<PRJ>-F<number>` è per progetto e non si
-- riusa, quindi eliminare lascia una LAPIDE (`deleted_at`) e la riga sparisce da
-- ogni lettura; l'oggetto nello storage si toglie dopo il commit, e
-- `storage_purged` dice se è andata (il timer del server ritenta). Il nome è
-- unico fra i file VIVI del progetto, senza maiuscole: un doppione prende « (2)».
CREATE TABLE "drive_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"storage_purged" boolean DEFAULT false NOT NULL,
	CONSTRAINT "drive_files_source_chk" CHECK ("source" in ('upload')),
	CONSTRAINT "drive_files_type_chk" CHECK ("type" in ('document', 'sheet', 'slides', 'pdf', 'image', 'other'))
);
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_added_by_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_deleted_by_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "drive_files_project_number_idx" ON "drive_files" USING btree ("project_id", "number");
--> statement-breakpoint
CREATE UNIQUE INDEX "drive_files_storage_key_idx" ON "drive_files" USING btree ("storage_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "drive_files_live_name_idx" ON "drive_files" USING btree ("project_id", lower("name")) WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "drive_files_unpurged_idx" ON "drive_files" USING btree ("deleted_at") WHERE "deleted_at" IS NOT NULL AND NOT "storage_purged";
--> statement-breakpoint
-- Un'apertura (anteprima, download): conta per «Più usati» (90 giorni) e per la
-- storia, che vede solo `drive.history`. La deduplica dei 30 minuti per persona
-- la fa chi scrive.
CREATE TABLE "drive_opens" (
	"file_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"via" text NOT NULL,
	CONSTRAINT "drive_opens_via_chk" CHECK ("via" in ('preview', 'download'))
);
--> statement-breakpoint
ALTER TABLE "drive_opens" ADD CONSTRAINT "drive_opens_file_fk" FOREIGN KEY ("file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "drive_opens" ADD CONSTRAINT "drive_opens_person_fk" FOREIGN KEY ("person_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "drive_opens_file_at_idx" ON "drive_opens" USING btree ("file_id", "at");
--> statement-breakpoint
-- Le citazioni della Chat accolgono i file del Drive.
ALTER TABLE "chat_message_citations" DROP CONSTRAINT "chat_message_citations_kind_chk";
--> statement-breakpoint
ALTER TABLE "chat_message_citations" ADD CONSTRAINT "chat_message_citations_kind_chk" CHECK ("kind" in ('task', 'request', 'project', 'person', 'doc', 'drive'));
--> statement-breakpoint
-- D3 (M): i permessi del Drive ai preset, come il prototipo: `drive.upload` a
-- Project Lead, Developer, Contributor e Legacy Member; `drive.manage` e
-- `drive.history` al solo Project Lead; al Viewer niente. E a OGNI ruolo di
-- progetto che conteneva già tutti i permessi di quel preset (la regola della
-- 0135, `docs/invariants/permissions.md`): prima i ruoli, poi il preset.
UPDATE "roles" AS r
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest(r."permissions" || ARRAY['drive.upload', 'drive.manage', 'drive.history']) AS p)
WHERE r."scope" = 'project'
	AND r."preset_key" IS DISTINCT FROM 'project_lead'
	AND r."permissions" @> (SELECT "permissions" FROM "roles" WHERE "preset_key" = 'project_lead');
--> statement-breakpoint
UPDATE "roles" AS r
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest(r."permissions" || ARRAY['drive.upload']) AS p)
WHERE r."scope" = 'project'
	AND r."preset_key" IS DISTINCT FROM 'developer'
	AND r."permissions" @> (SELECT "permissions" FROM "roles" WHERE "preset_key" = 'developer');
--> statement-breakpoint
UPDATE "roles" AS r
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest(r."permissions" || ARRAY['drive.upload']) AS p)
WHERE r."scope" = 'project'
	AND r."preset_key" IS DISTINCT FROM 'contributor'
	AND r."permissions" @> (SELECT "permissions" FROM "roles" WHERE "preset_key" = 'contributor');
--> statement-breakpoint
UPDATE "roles" AS r
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest(r."permissions" || ARRAY['drive.upload']) AS p)
WHERE r."scope" = 'project'
	AND r."preset_key" IS DISTINCT FROM 'legacy_member'
	AND r."permissions" @> (SELECT "permissions" FROM "roles" WHERE "preset_key" = 'legacy_member');
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest("permissions" || ARRAY['drive.upload', 'drive.manage', 'drive.history']) AS p)
WHERE "preset_key" = 'project_lead';
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest("permissions" || ARRAY['drive.upload']) AS p)
WHERE "preset_key" IN ('developer', 'contributor', 'legacy_member');
