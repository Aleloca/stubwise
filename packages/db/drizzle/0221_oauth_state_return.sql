-- Rimandi, lotto 4 (§6): il ritorno OAuth della casella all'app desktop. Dove
-- porta il callback lo decide l'avvio del collegamento, scritto sulla riga del
-- nonce; null = il web di sempre.
ALTER TABLE "oauth_states" ADD COLUMN "client" text;
--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "return_state" text;
--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_client_chk" CHECK (client IS NULL OR client IN ('web', 'desktop'));
