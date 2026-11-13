-- Area 7, fetta 4 (13 nov 2026): le automazioni generali, il webhook in
-- arrivo, la tabella cliente → progetto e «avvia un'altra automazione».
--
-- I valori d'enum nuovi stanno in statement a sé e nessuno li usa in questo
-- batch (il migratore gira in UNA transazione, vedi CLAUDE.md).
ALTER TYPE "automation_event_kind" ADD VALUE IF NOT EXISTS 'source_event';
--> statement-breakpoint
-- «Avvia un'altra»: l'effetto è l'esecuzione figlia (`object_id`).
ALTER TYPE "automation_effect_kind" ADD VALUE IF NOT EXISTS 'run';
--> statement-breakpoint
-- Le generali: nessun progetto, codici `AUT-<n>` da una sequenza d'istanza.
ALTER TABLE "automations" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "automation_general_code_seq" START 1;
--> statement-breakpoint
-- F4-2 = c: il tetto del webhook scelto da chi gestisce l'automazione (null = il default).
ALTER TABLE "automations" ADD COLUMN "webhook_per_minute" integer;
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "webhook_per_day" integer;
--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_webhook_caps_chk" CHECK (("webhook_per_minute" IS NULL OR "webhook_per_minute" > 0) AND ("webhook_per_day" IS NULL OR "webhook_per_day" > 0));
--> statement-breakpoint
-- Le sorgenti: per la F4 solo il webhook in arrivo. Il segreto si salva come hash (sha256 esadecimale).
CREATE TABLE "automation_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"example" jsonb,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"regenerated_by" uuid,
	"regenerated_at" timestamp with time zone,
	CONSTRAINT "automation_sources_kind_chk" CHECK ("kind" = 'webhook')
);
--> statement-breakpoint
ALTER TABLE "automation_sources" ADD CONSTRAINT "automation_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_sources" ADD CONSTRAINT "automation_sources_regenerated_by_users_id_fk" FOREIGN KEY ("regenerated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_sources_secret_idx" ON "automation_sources" USING btree ("secret_hash");
--> statement-breakpoint
-- Gli eventi recenti di una sorgente (F4-5, F4-6): accettati, duplicati, rifiutati col motivo; gli ultimi 100.
CREATE TABLE "automation_source_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"payload" jsonb,
	"event_id" uuid,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "automation_source_events_status_chk" CHECK ("status" IN ('accepted', 'duplicate', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "automation_source_events" ADD CONSTRAINT "automation_source_events_source_id_automation_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."automation_sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "automation_source_events_source_idx" ON "automation_source_events" USING btree ("source_id", "received_at" DESC);
--> statement-breakpoint
-- Il tetto per finestra (al minuto, al giorno): contatori atomici anche con più processi.
CREATE TABLE "automation_source_hits" (
	"source_id" uuid NOT NULL,
	"window" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "automation_source_hits_pk" PRIMARY KEY ("source_id", "window", "window_start"),
	CONSTRAINT "automation_source_hits_window_chk" CHECK ("window" IN ('minute', 'day'))
);
--> statement-breakpoint
ALTER TABLE "automation_source_hits" ADD CONSTRAINT "automation_source_hits_source_id_automation_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."automation_sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- La tabella cliente → progetto: la chiave è `clientKeyOf` di shared (trim + lower).
CREATE TABLE "client_project_links" (
	"client_key" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"project_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_project_links_key_chk" CHECK ("client_key" <> '' AND "client_key" = lower(btrim("client_key")))
);
--> statement-breakpoint
ALTER TABLE "client_project_links" ADD CONSTRAINT "client_project_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_project_links" ADD CONSTRAINT "client_project_links_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- L'evento di una sorgente nell'outbox: né progetto né casella, la sorgente.
ALTER TABLE "automation_events" ADD COLUMN "source_id" uuid;
--> statement-breakpoint
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_source_id_automation_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."automation_sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_events" DROP CONSTRAINT "automation_events_project_or_account_chk";
--> statement-breakpoint
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_project_or_account_chk" CHECK ("project_id" IS NOT NULL OR "account_id" IS NOT NULL OR "source_id" IS NOT NULL);
--> statement-breakpoint
-- R-J13 lungo la catena («avvia un'altra»): la casella della posta che l'EVENTO dell'esecuzione porta
-- (quella d'origine della catena). Distinta da `mailbox_account_id`, da cui l'esecuzione manda.
ALTER TABLE "automation_runs" ADD COLUMN "mail_origin_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_mail_origin_account_id_google_accounts_id_fk" FOREIGN KEY ("mail_origin_account_id") REFERENCES "public"."google_accounts"("id") ON DELETE set null ON UPDATE no action;
