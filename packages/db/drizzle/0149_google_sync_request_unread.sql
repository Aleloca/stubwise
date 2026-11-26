-- Area 6, fetta 1 (12 nov 2026). «Aggiorna ora» di una casella: la richiesta in
-- attesa (null = nessuna; il worker la azzera a fine giro) e l'ultima fatta,
-- che resta per il tetto dei 60 s. E il letto/non letto di un messaggio,
-- sincronizzato con Gmail (D5 = b): null = non ancora saputo, letto come false.
ALTER TABLE "google_accounts" ADD COLUMN "sync_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "google_accounts" ADD COLUMN "sync_last_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "unread" boolean;
