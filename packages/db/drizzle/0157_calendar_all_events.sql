-- Area 6, F3b: il calendario con TUTTI gli eventi (vedi lo schema).
ALTER TABLE "calendar_events" ADD COLUMN "proposal_candidate" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "event_type" text;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "transparency" text;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "project_by" text;
--> statement-breakpoint
CREATE INDEX "calendar_events_account_starts_idx" ON "calendar_events" USING btree ("account_id", "starts_at");
--> statement-breakpoint
ALTER TABLE "google_accounts" ADD COLUMN "calendar_baseline_at" timestamp with time zone;
--> statement-breakpoint
-- Un resync della finestra al primo giro: col syncToken un giro incrementale
-- non porterebbe mai gli eventi personali già esistenti.
UPDATE "google_accounts" SET "calendar_sync_token" = NULL;
