-- Lotto 9, voce 2 (d): le proposte del calendario CONDIVISE fra gli invitati.
-- Una proposta per appuntamento (`ical_uid`, le copie dello stesso evento
-- nelle caselle sono un evento solo) e progetto; i destinatari sono gli
-- invitati di Stubwise che non hanno rifiutato E membri ESPLICITI del
-- progetto (audience `event_invitees`), ognuno con la sua card. Solo gli
-- eventi SINGOLI: le occorrenze delle serie restano per casella.
CREATE TABLE "calendar_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ical_uid" text NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"audience" text DEFAULT 'event_invitees' NOT NULL,
	"calendar_event_id" uuid REFERENCES "calendar_events"("id") ON DELETE SET NULL,
	"google_event_id" text NOT NULL,
	"title" text,
	"starts_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"outcome" jsonb,
	"error" text,
	"decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_proposals_status_chk" CHECK (status in ('proposed', 'actioned', 'ignored', 'failed')),
	CONSTRAINT "calendar_proposals_audience_chk" CHECK (audience in ('event_invitees'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_proposals_ical_uid_project_id_unique" ON "calendar_proposals" USING btree ("ical_uid", "project_id");
--> statement-breakpoint
-- I destinatari, uno per persona, con la loro card. `declined_at`: l'invitato
-- ha rifiutato DOPO la pubblicazione, la sua card è chiusa e non la vede più.
CREATE TABLE "calendar_proposal_recipients" (
	"proposal_id" uuid NOT NULL REFERENCES "calendar_proposals"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"notification_id" uuid REFERENCES "notifications"("id") ON DELETE SET NULL,
	"declined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_proposal_recipients_pk" PRIMARY KEY("proposal_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "calendar_proposal_recipients_user_id_idx" ON "calendar_proposal_recipients" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "calendar_proposal_recipients_notification_id_idx" ON "calendar_proposal_recipients" USING btree ("notification_id");
--> statement-breakpoint
-- La copia dell'evento in una casella è stata trattata dal percorso condiviso
-- (il marcatore: il percorso per casella non la prende più).
ALTER TABLE "calendar_events" ADD COLUMN "calendar_proposal_id" uuid REFERENCES "calendar_proposals"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "calendar_events_calendar_proposal_id_idx" ON "calendar_events" USING btree ("calendar_proposal_id");
