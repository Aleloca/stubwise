-- Area 6, fetta 2 (12 nov 2026): la classificazione nuova (D3) e la proposta
-- CONDIVISA per email e progetto (D4).
-- Il messaggio: il Message-ID RFC (la chiave dell'email fra caselle), lo stato
-- della classificazione, importanza, scadenza e progetti incerti.
ALTER TABLE "email_messages" ADD COLUMN "rfc_message_id" text;
--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "classification_state" text;
--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "importance" text;
--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "due_date" date;
--> statement-breakpoint
ALTER TABLE "email_messages" ADD COLUMN "uncertain_project_ids" uuid[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_classification_state_chk" CHECK ("classification_state" is null or "classification_state" in ('off', 'pending', 'failed', 'done'));
--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_importance_chk" CHECK ("importance" is null or "importance" in ('high', 'normal', 'low'));
--> statement-breakpoint
CREATE INDEX "email_messages_rfc_message_id_idx" ON "email_messages" USING btree ("rfc_message_id") WHERE rfc_message_id is not null;
--> statement-breakpoint
-- La proposta: condivisa (`mail_recipients`) o di una casella (`mailbox_owner`,
-- le righe di prima e il calendario), e la decisione che vale per tutti.
ALTER TABLE "email_proposals" ADD COLUMN "rfc_message_id" text;
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD COLUMN "audience" text DEFAULT 'mailbox_owner' NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD COLUMN "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD COLUMN "decided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD COLUMN "confirmed_indices" integer[];
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD COLUMN "results" jsonb;
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD COLUMN "handed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD COLUMN "handed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD CONSTRAINT "email_proposals_audience_chk" CHECK ("audience" in ('mailbox_owner', 'mail_recipients'));
--> statement-breakpoint
CREATE UNIQUE INDEX "email_proposals_rfc_message_id_project_id_unique" ON "email_proposals" USING btree ("rfc_message_id", "project_id") WHERE rfc_message_id is not null;
--> statement-breakpoint
-- I destinatari in Stubwise membri del progetto, uno per persona, con la loro
-- notifica (la card della loro inbox).
CREATE TABLE "email_proposal_recipients" (
	"proposal_id" uuid NOT NULL REFERENCES "email_proposals"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"notification_id" uuid REFERENCES "notifications"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_proposal_recipients_pk" PRIMARY KEY("proposal_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "email_proposal_recipients_user_id_idx" ON "email_proposal_recipients" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "email_proposal_recipients_notification_id_idx" ON "email_proposal_recipients" USING btree ("notification_id");
