-- R3 del ritiro del web vecchio, la pulizia dei dati
-- (docs/plans/2026-11-28-ritiro-web-vecchio-piano.md §1.1 e §3). Da R2 nessun
-- codice legge o scrive Slack né `saved_views`; qui se ne vanno le consegne
-- Slack e la tabella. Le COLONNE Slack restano: le toglie la 0247 (R3b), dopo
-- la verifica in produzione, perché il codice di R2 le nomina ancora e il
-- rollback fino a R2 deve reggere. E il token degli inviti diventa un hash, calcolato sul posto:
-- i link già spediti funzionano ancora, perché il server ora cerca
-- `sha256(token)` (`apps/server/src/services/invite-token.ts`).
--
-- ⚠️ Dopo questa migrazione si scende AL MASSIMO a R2, come per la 0245.
-- Con R2 gli inviti in sospeso non si aprono (R2 li cerca col token in
-- chiaro): un limite del rollback, scritto nel deploy-log («Il taglio del web
-- vecchio, R3»).
-- ⚠️ Il `when` sta dopo quello della 0245: drizzle applica per `when`, e il
-- test del journal (`migration-0245.test.ts`) lo tiene vero per ogni voce.
-- Ogni DROP in uno statement a sé; nessun `ADD VALUE`.

-- 1. Le consegne Slack: da R2 il poller le chiude `skipped`, e nessuno le legge
-- più. Il riferimento al messaggio sul canale esterno (il `ts` di Slack) era
-- solo loro (la colonna la toglie la 0247, che ricrea anche l'enum dei canali
-- senza `slack_dm` e `slack_update`).
DELETE FROM "notification_deliveries" WHERE "channel" IN ('slack_dm', 'slack_update');
--> statement-breakpoint
-- 2. Le viste salvate del web vecchio (con la tabella cadono i due indici e
--    la chiave esterna verso gli utenti).
DROP TABLE "saved_views";
--> statement-breakpoint
-- 3. Il token degli inviti come hash: `sha256` esadecimale del token in
--    chiaro, come lo calcola il server (`hashInviteToken`). Due tabelle lo
--    referenziano senza `ON UPDATE CASCADE`: si tolgono le chiavi esterne, si
--    aggiornano padre e figli con la stessa funzione, si rimettono identiche.
ALTER TABLE "invite_projects" DROP CONSTRAINT "invite_projects_invite_token_invites_token_fk";
--> statement-breakpoint
ALTER TABLE "invite_workspaces" DROP CONSTRAINT "invite_workspaces_invite_token_fkey";
--> statement-breakpoint
UPDATE "invites" SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex');
--> statement-breakpoint
UPDATE "invite_projects" SET "invite_token" = encode(sha256(convert_to("invite_token", 'UTF8')), 'hex');
--> statement-breakpoint
UPDATE "invite_workspaces" SET "invite_token" = encode(sha256(convert_to("invite_token", 'UTF8')), 'hex');
--> statement-breakpoint
ALTER TABLE "invite_projects" ADD CONSTRAINT "invite_projects_invite_token_invites_token_fk" FOREIGN KEY ("invite_token") REFERENCES "public"."invites"("token") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invite_workspaces" ADD CONSTRAINT "invite_workspaces_invite_token_fkey" FOREIGN KEY ("invite_token") REFERENCES "public"."invites"("token") ON DELETE cascade;
