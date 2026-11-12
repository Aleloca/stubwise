-- Area 6, F3: la firma di Gmail della casella, in copia (vedi lo schema).
ALTER TABLE "google_accounts" ADD COLUMN "signature_text" text;
--> statement-breakpoint
ALTER TABLE "google_accounts" ADD COLUMN "signature_fetched_at" timestamp with time zone;
