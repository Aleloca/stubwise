-- Area 6, fetta 3 (scrivere): le bozze sono bozze di GMAIL (D7 = b); qui sta
-- solo ciò che Gmail non sa (la modalità, la citazione, il messaggio a cui si
-- risponde) e la versione vista all'ultimo salvataggio (il conflitto).
CREATE TABLE "mail_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"account_id" uuid NOT NULL REFERENCES "google_accounts"("id") ON DELETE CASCADE,
	"gmail_draft_id" text NOT NULL,
	"gmail_message_id" text,
	"thread_id" text,
	"mode" text NOT NULL,
	"reply_to_message_id" uuid REFERENCES "email_messages"("id") ON DELETE SET NULL,
	"quote" boolean DEFAULT true NOT NULL,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_drafts_mode_chk" CHECK ("mode" in ('new', 'reply', 'replyAll', 'forward')),
	CONSTRAINT "mail_drafts_state_chk" CHECK ("state" in ('active', 'sending'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_drafts_slot_unique" ON "mail_drafts" USING btree ("user_id", "account_id", coalesce("thread_id", ''), "mode") WHERE state = 'active';
--> statement-breakpoint
CREATE INDEX "mail_drafts_user_id_idx" ON "mail_drafts" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "mail_draft_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL REFERENCES "mail_drafts"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime_type" text NOT NULL,
	"storage_key" text,
	"drive_file_id" uuid REFERENCES "drive_files"("id") ON DELETE SET NULL,
	"as" text DEFAULT 'copy' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_draft_attachments_as_chk" CHECK ("as" in ('copy', 'link'))
);
--> statement-breakpoint
CREATE INDEX "mail_draft_attachments_draft_id_idx" ON "mail_draft_attachments" USING btree ("draft_id");
--> statement-breakpoint
-- Gli invii trattenuti 10 s dal server (D6): una riga per Invia, con chi l'ha
-- chiesto e quando parte. Il worker la manda allo scadere, MAI da solo dopo un
-- fallimento (Riprova è un gesto).
CREATE TABLE "mail_outgoing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"account_id" uuid NOT NULL REFERENCES "google_accounts"("id") ON DELETE CASCADE,
	"draft_id" uuid REFERENCES "mail_drafts"("id") ON DELETE SET NULL,
	"gmail_draft_id" text NOT NULL,
	"thread_id" text,
	"send_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"gmail_message_id" text,
	"gmail_thread_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_outgoing_state_chk" CHECK ("state" in ('queued', 'sending', 'sent', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX "mail_outgoing_due_idx" ON "mail_outgoing" USING btree ("send_at") WHERE state = 'queued';
--> statement-breakpoint
CREATE INDEX "mail_outgoing_user_id_idx" ON "mail_outgoing" USING btree ("user_id");
