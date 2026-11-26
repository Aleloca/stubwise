-- Rimandi, lotto 5 (A9): l'ultima prova di un webhook in uscita, perché la
-- pagina la mostri anche dopo un ricaricamento. La scrive `POST …/test`;
-- cambiare indirizzo o formato la toglie (come il prototipo).
ALTER TABLE "outgoing_webhooks" ADD COLUMN "last_test_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "outgoing_webhooks" ADD COLUMN "last_test_outcome" text;
--> statement-breakpoint
ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_last_test_outcome_chk" CHECK (last_test_outcome IS NULL OR last_test_outcome IN ('ok', 'invalid_credentials', 'unreachable'));
