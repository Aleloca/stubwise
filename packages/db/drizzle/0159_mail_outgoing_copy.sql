-- Review della F3, punti 6 e 10: il Message-ID nostro sulla bozza, e sulla
-- riga d'invio la copia di ciò che serve dopo che la bozza se n'è andata.
ALTER TABLE "mail_drafts" ADD COLUMN "rfc_message_id" text;
--> statement-breakpoint
ALTER TABLE "mail_outgoing" ADD COLUMN "rfc_message_id" text;
--> statement-breakpoint
ALTER TABLE "mail_outgoing" ADD COLUMN "to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "mail_outgoing" ADD COLUMN "cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "mail_outgoing" ADD COLUMN "subject" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mail_outgoing" ADD COLUMN "body" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE INDEX "mail_outgoing_rfc_message_id_idx" ON "mail_outgoing" USING btree ("account_id", "rfc_message_id");
