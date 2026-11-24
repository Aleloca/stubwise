-- Review del lotto 5 (M-5): l'ultima prova di un webhook dice anche il codice
-- con cui la destinazione ha risposto, e un esito in più: `destination_error`
-- (ha risposto con un errore che non è 401/403). `invalid_credentials` resta
-- per 401/403.
ALTER TABLE "outgoing_webhooks" ADD COLUMN "last_test_status" integer;
--> statement-breakpoint
ALTER TABLE "outgoing_webhooks" DROP CONSTRAINT "outgoing_webhooks_last_test_outcome_chk";
--> statement-breakpoint
ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_last_test_outcome_chk" CHECK (last_test_outcome IS NULL OR last_test_outcome IN ('ok', 'invalid_credentials', 'unreachable', 'destination_error'));
