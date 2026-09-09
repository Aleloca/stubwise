-- Fase 7b — Posta e Calendario dentro la piattaforma. Additiva, un solo
-- batch, nessun ALTER TYPE (vedi la trappola delle migrazioni batch in
-- CLAUDE.md).
--
-- 1) La serie ricorrente entra nel modello: `recurringEventId` è l'id
--    dell'evento padre che Google manda già su ogni occorrenza
--    (singleEvents=true) e che finora perdevamo allo zod parse.
ALTER TABLE "calendar_events" ADD COLUMN "recurring_event_id" text;--> statement-breakpoint
CREATE INDEX "calendar_events_account_recurring_idx" ON "calendar_events" USING btree ("account_id","recurring_event_id");--> statement-breakpoint

-- 2) Configurazione di una serie riconosciuta. Non esiste finché l'utente non
--    la configura dalla sezione Calendario: fino ad allora la serie è solo un
--    gruppo di righe in calendar_events, spenta per definizione (nessuna
--    riga qui = non pronta). `enabled` default false è la lezione delle 730
--    notifiche del 9 settembre 2026 (design fase 7b §4): una serie nuova non
--    deve poter fare niente da sola.
CREATE TABLE "calendar_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"recurring_event_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"project_id" uuid,
	"action" text DEFAULT 'milestone' NOT NULL,
	"lead_days" integer DEFAULT 2 NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_series" ADD CONSTRAINT "calendar_series_account_id_google_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."google_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_series" ADD CONSTRAINT "calendar_series_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_series_account_recurring_unique" ON "calendar_series" USING btree ("account_id","recurring_event_id");--> statement-breakpoint
ALTER TABLE "calendar_series" ADD CONSTRAINT "calendar_series_lead_days_chk" CHECK (lead_days between 0 and 30);--> statement-breakpoint
ALTER TABLE "calendar_series" ADD CONSTRAINT "calendar_series_action_chk" CHECK (action in ('backlog_item', 'milestone', 'reminder'));
