-- Lotto 8, voce 2: rispondere da un alias di Gmail (send-as). Nessuno scope
-- nuovo: `users.settings.sendAs.list` accetta `gmail.modify`. La copia degli
-- alias verificati della casella (con la firma di ciascuno) e da quale
-- indirizzo parte una bozza.
ALTER TABLE "google_accounts" ADD COLUMN "send_as" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "google_accounts" ADD COLUMN "send_as_fetched_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "from_address" text;
