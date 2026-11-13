-- Area 6, F5b: i riferimenti a Google Drive nel Drive dei progetti (vedi lo
-- schema). Un riferimento non ha byte in archiviazione; le cartelle Google
-- collegate; l'apertura «via Google».
CREATE TABLE "drive_folder_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"google_folder_id" text NOT NULL,
	"name" text NOT NULL,
	"linked_by" uuid,
	"account_id" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "drive_folder_links" ADD CONSTRAINT "drive_folder_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "drive_folder_links" ADD CONSTRAINT "drive_folder_links_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "drive_folder_links" ADD CONSTRAINT "drive_folder_links_account_id_google_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."google_accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "drive_folder_links_project_folder_idx" ON "drive_folder_links" USING btree ("project_id","google_folder_id");
--> statement-breakpoint
ALTER TABLE "drive_files" ALTER COLUMN "size_bytes" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "drive_files" ALTER COLUMN "storage_key" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "google_file_id" text;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "google_owner" text;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "google_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_google_account_id_google_accounts_id_fk" FOREIGN KEY ("google_account_id") REFERENCES "public"."google_accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "folder_link_id" uuid;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "hidden_by" uuid;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "hidden_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "modified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "unavailable" text;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_folder_link_id_drive_folder_links_id_fk" FOREIGN KEY ("folder_link_id") REFERENCES "public"."drive_folder_links"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_hidden_by_users_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "drive_files" DROP CONSTRAINT "drive_files_source_chk";
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_source_chk" CHECK ("drive_files"."source" in ('upload', 'google'));
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_upload_storage_chk" CHECK ("drive_files"."source" <> 'upload' OR ("drive_files"."storage_key" IS NOT NULL AND "drive_files"."size_bytes" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_google_id_chk" CHECK ("drive_files"."source" <> 'google' OR "drive_files"."google_file_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_unavailable_chk" CHECK ("drive_files"."unavailable" IS NULL OR "drive_files"."unavailable" = 'deleted');
--> statement-breakpoint
DROP INDEX "drive_files_live_name_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "drive_files_live_name_idx" ON "drive_files" USING btree ("project_id",lower("name")) WHERE "drive_files"."deleted_at" IS NULL AND "drive_files"."source" = 'upload';
--> statement-breakpoint
CREATE UNIQUE INDEX "drive_files_live_google_idx" ON "drive_files" USING btree ("project_id","google_file_id") WHERE "drive_files"."deleted_at" IS NULL AND "drive_files"."source" = 'google';
--> statement-breakpoint
CREATE INDEX "drive_files_folder_link_idx" ON "drive_files" USING btree ("folder_link_id");
--> statement-breakpoint
ALTER TABLE "drive_opens" DROP CONSTRAINT "drive_opens_via_chk";
--> statement-breakpoint
ALTER TABLE "drive_opens" ADD CONSTRAINT "drive_opens_via_chk" CHECK ("drive_opens"."via" in ('preview', 'download', 'google'));
