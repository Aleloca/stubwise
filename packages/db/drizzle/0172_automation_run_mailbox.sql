-- Area 7, fetta 2, fix della review (13 nov 2026).
--
-- C1: la casella di un'ESECUZIONE (`automation_runs.mailbox_account_id`): da
-- quella manda, su quella si sveglia, e il proprietario di QUELLA casella
-- (`google_accounts.user_id`) è il solo che ne legge la posta. Ripubblicare
-- l'automazione con un'altra casella non sposta le esecuzioni già partite.
-- Le esecuzioni di prima prendono la casella dell'automazione.
--
-- I2: `automations.listens_mail`, scritto alla pubblicazione: l'automazione
-- ascolta la posta della sua casella («email in arrivo»). Una che manda
-- soltanto non fa leggere niente.
ALTER TABLE "automation_runs" ADD COLUMN "mailbox_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_mailbox_account_id_google_accounts_id_fk" FOREIGN KEY ("mailbox_account_id") REFERENCES "public"."google_accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
UPDATE "automation_runs" r SET "mailbox_account_id" = a."mailbox_account_id" FROM "automations" a WHERE a."id" = r."automation_id" AND a."mailbox_account_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "listens_mail" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "automations" a SET "listens_mail" = true WHERE EXISTS (
	SELECT 1 FROM "automation_versions" v
	WHERE v."automation_id" = a."id" AND v."published_at" IS NOT NULL
		AND v."flow"->'trigger'->>'kind' = 'stubwise' AND v."flow"->'trigger'->>'event' = 'mail_received'
		AND v."n" = (SELECT max(v2."n") FROM "automation_versions" v2 WHERE v2."automation_id" = a."id" AND v2."published_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "automations_listens_mail_idx" ON "automations" USING btree ("mailbox_account_id") WHERE "listens_mail" AND "status" = 'active';
