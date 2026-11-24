-- Rimandi, lotto 5 (A9): le ultime 4 cifre dei segreti che la pagina mostra
-- «•••• 9e2b», come `ai_providers.secret_last4` (0190): la chiave dello
-- storage S3, il token di un account git, il client secret di un'app Google.
-- Scritte quando il segreto si crea o si sostituisce; le righe di prima
-- restano NULL finché non lo si sostituisce (il server non decifra per
-- ricavarle).
ALTER TABLE "instance_settings" ADD COLUMN "s3_secret_key_last4" text;
--> statement-breakpoint
ALTER TABLE "git_accounts" ADD COLUMN "token_last4" text;
--> statement-breakpoint
ALTER TABLE "google_workspaces" ADD COLUMN "client_secret_last4" text;
