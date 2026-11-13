-- Area 7, fetta 2 (13 nov 2026): email e attese
-- (`docs/plans/2026-11-13-integrazione-area7-fetta2-plan.md`, S1 e le
-- «Correzioni di 72» C-F2-0…C-F2-5).
--
-- I valori d'enum nuovi stanno ognuno in uno statement a sé e NON si usano in
-- questo batch (né in un default, né in un indice parziale, né in un
-- confronto): il migratore gira tutto in UNA transazione, e Postgres non
-- permette di usare un valore d'enum nella transazione che l'ha aggiunto.
ALTER TYPE "automation_run_status" ADD VALUE IF NOT EXISTS 'waiting_event';
--> statement-breakpoint
ALTER TYPE "automation_effect_kind" ADD VALUE IF NOT EXISTS 'email';
--> statement-breakpoint
ALTER TYPE "automation_paused_reason" ADD VALUE IF NOT EXISTS 'mailbox_lost';
--> statement-breakpoint
ALTER TYPE "automation_event_kind" ADD VALUE IF NOT EXISTS 'mail_received';
--> statement-breakpoint
-- La casella scelta all'accensione (R-J15): del proprietario di adesso. Una
-- casella scollegata lascia l'automazione senza casella (la casella persa).
ALTER TABLE "automations" ADD COLUMN "mailbox_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_mailbox_account_id_google_accounts_id_fk" FOREIGN KEY ("mailbox_account_id") REFERENCES "public"."google_accounts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- C-F2-1: un'email d'automazione non ha una bozza Gmail. Una riga di persona
-- l'ha sempre; una riga senza bozza è sempre di un'esecuzione.
ALTER TABLE "mail_outgoing" ADD COLUMN "automation_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "mail_outgoing" ADD CONSTRAINT "mail_outgoing_automation_run_id_automation_runs_id_fk" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mail_outgoing" ALTER COLUMN "gmail_draft_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mail_outgoing" ADD CONSTRAINT "mail_outgoing_draft_or_run_chk" CHECK ("gmail_draft_id" IS NOT NULL OR "automation_run_id" IS NOT NULL);
--> statement-breakpoint
-- C-F2-5 (il botta e risposta) e l'attesa della risposta: le conversazioni
-- in cui un'esecuzione ha mandato un'email, per casella e thread.
CREATE INDEX "mail_outgoing_automation_thread_idx" ON "mail_outgoing" USING btree ("account_id", "gmail_thread_id") WHERE "automation_run_id" IS NOT NULL;
--> statement-breakpoint
-- C-F2-4: cosa aspetta un `wait`, in colonne con un indice, perché il poller
-- Google e il consumatore sveglino SOLO le attese giuste.
ALTER TABLE "automation_runs" ADD COLUMN "waiting_thread" text;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "waiting_ticket_id" uuid;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_waiting_ticket_id_tickets_id_fk" FOREIGN KEY ("waiting_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "automation_runs_waiting_thread_idx" ON "automation_runs" USING btree ("waiting_thread") WHERE "waiting_thread" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "automation_runs_waiting_ticket_idx" ON "automation_runs" USING btree ("waiting_ticket_id") WHERE "waiting_ticket_id" IS NOT NULL;
--> statement-breakpoint
-- Le attese a tempo scadono su `due_at` come le esecuzioni dovute: l'indice
-- parziale della 0169 (`status = 'running'`) diventa pieno, perché un indice
-- parziale su `waiting_event` nominerebbe il valore nuovo in questo batch.
DROP INDEX "automation_runs_due_idx";
--> statement-breakpoint
CREATE INDEX "automation_runs_due_idx" ON "automation_runs" USING btree ("due_at");
--> statement-breakpoint
-- L'idempotenza degli inizi a orario: una riga per automazione e giorno
-- locale (Europe/Rome). Il vincolo è ciò che fa scattare una volta sola.
CREATE TABLE "automation_schedule_fires" (
	"automation_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_schedule_fires_pk" PRIMARY KEY ("automation_id", "local_date")
);
--> statement-breakpoint
ALTER TABLE "automation_schedule_fires" ADD CONSTRAINT "automation_schedule_fires_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_schedule_fires" ADD CONSTRAINT "automation_schedule_fires_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- C-F2-0: un evento della posta non ha una riga di Stubwise (un messaggio
-- rifiutato dall'ammissione non entra in `email_messages`): `object_id`
-- diventa facoltativo, e la deduplica passa da `dedupe_key`
-- (`mail:<accountId>:<gmailMessageId>`).
-- Non ha nemmeno un progetto: le automazioni che ascolta sono quelle della
-- CASELLA (`account_id`, solo del proprietario: `mailbox_owner`, R-J13).
ALTER TABLE "automation_events" ALTER COLUMN "object_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "automation_events" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "automation_events" ADD COLUMN "account_id" uuid;
--> statement-breakpoint
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_account_id_google_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."google_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_project_or_account_chk" CHECK ("project_id" IS NOT NULL OR "account_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "automation_events" ADD COLUMN "dedupe_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_events_dedupe_idx" ON "automation_events" USING btree ("dedupe_key") WHERE "dedupe_key" IS NOT NULL;
