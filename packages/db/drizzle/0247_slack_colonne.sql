-- R3b del ritiro del web vecchio, il passo finale
-- (docs/plans/2026-11-28-ritiro-web-vecchio-piano.md §1.1 e §3): via le
-- colonne Slack, il riferimento esterno delle consegne e i due canali Slack
-- dell'enum. Da R3 nessun codice le nomina; la 0246 le aveva lasciate perché il
-- codice di R2 le nominava ancora, e il rollback a R2 doveva reggere.
--
-- ⚠️ Dopo questa migrazione si scende AL MASSIMO a R3: il codice di R2 nomina
-- le colonne Slack a ogni richiesta autenticata. Sotto R3 si torna solo col
-- backup (deploy-log, «Il taglio del web vecchio, R3b»).
-- ⚠️ Il `when` sta dopo quello della 0246 (il test del journal in
-- `migration-0245.test.ts`). Ogni DROP in uno statement a sé; nessun
-- `ADD VALUE`: l'enum si ricrea, non si allarga.

-- 1. Le colonne Slack (con `slack_user_id` cade `users_slack_user_id_unique`).
ALTER TABLE "users" DROP COLUMN "slack_user_id";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "slack_avatar_url";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "notify_slack_dm";
--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "slack_user_id";
--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "slack_avatar_url";
--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "slack_signing_secret_encrypted";
--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "slack_bot_token_encrypted";
--> statement-breakpoint
-- 2. Le consegne: una riga Slack scritta fra la 0246 e qui (un worker di
--    prima) impedirebbe il cambio di tipo; il riferimento esterno era solo
--    loro.
DELETE FROM "notification_deliveries" WHERE "channel" IN ('slack_dm', 'slack_update');
--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP COLUMN "external_ref";
--> statement-breakpoint
-- 3. L'enum dei canali senza `slack_dm` e `slack_update`. Togliere un valore
--    da un enum vuol dire ricrearlo: il tipo vecchio si rinomina, il nuovo
--    nasce col nome di sempre (CREATE TYPE, i cui valori si possono usare
--    nella stessa transazione, a differenza di un ADD VALUE), la colonna
--    passa al nuovo per testo, il vecchio si toglie. I due CHECK che
--    confrontano `channel` con un letterale del tipo vecchio si tolgono prima
--    e si rimettono identici dopo.
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_channel_shape_chk";
--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_webhook_event_chk";
--> statement-breakpoint
ALTER TYPE "public"."delivery_channel" RENAME TO "delivery_channel_old";
--> statement-breakpoint
CREATE TYPE "public"."delivery_channel" AS ENUM('webhook', 'push');
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ALTER COLUMN "channel" TYPE "public"."delivery_channel" USING "channel"::text::"public"."delivery_channel";
--> statement-breakpoint
DROP TYPE "public"."delivery_channel_old";
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_shape_chk" CHECK ((channel = 'webhook') = (notification_id IS NULL));
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_webhook_event_chk" CHECK (channel <> 'webhook' OR event IS NOT NULL);
