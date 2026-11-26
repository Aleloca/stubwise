-- Review della F3 dell'area 5 (12 nov 2026): la semina della coda del
-- contenuto (`seedPendingDriveJobs`, a ogni giro del poller del worker) cerca i
-- file vivi in `pending`. Un indice parziale, piccolo: i file ci restano poco.
CREATE INDEX "drive_files_content_pending_idx" ON "drive_files" USING btree ("added_at") WHERE "content_status" = 'pending' AND "deleted_at" IS NULL;
