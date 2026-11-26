-- Area 6, fetta 1 (12 nov 2026, decisione del maintainer): con le proposte
-- spente una casella si LEGGE comunque; si spengono solo le proposte. Il claim
-- del poller non guarda più `proposals_enabled`, e l'indice segue.
-- `proposals_since`: quando le proposte sono state RIACCESE; la posta
-- ingerita prima non diventa mai una proposta (nessun recupero retroattivo).
-- Null = nessun taglio (le caselle che le hanno sempre avute accese).
ALTER TABLE "google_accounts" ADD COLUMN "proposals_since" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "google_accounts_due_idx";
--> statement-breakpoint
CREATE INDEX "google_accounts_due_idx" ON "google_accounts" USING btree ("next_sync_at") WHERE disabled_at is null;
