-- Area 8, fetta 2: gli avvisi e le iscrizioni per progetto.
-- I `notification_kind` del catalogo, ognuno in uno statement a sé e mai usato
-- nello stesso batch (il migratore gira in UNA transazione: CLAUDE.md).
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'release.merged';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'release.succeeded';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'pr.opened';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'pr.analysis_issues';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'pr.corrected';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'docs.release_note';
--> statement-breakpoint
-- Le iscrizioni: lo stato di ADESSO, per persona, progetto e tipo del catalogo
-- (`@stubwise/shared`). Nessuna riga = il default del catalogo dai permessi di
-- adesso. Niente storia (ruling della F2): la card nasce alla pubblicazione.
CREATE TABLE "alert_subscriptions" (
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"alert_type" text NOT NULL,
	"app" boolean NOT NULL,
	"phone" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_subscriptions_pk" PRIMARY KEY ("user_id", "project_id", "alert_type"),
	CONSTRAINT "alert_subscriptions_type_chk" CHECK ("alert_type" ~ '^[a-z]+(\.[a-z_]+)+$')
);
--> statement-breakpoint
CREATE INDEX "alert_subscriptions_project_type_idx" ON "alert_subscriptions" USING btree ("project_id", "alert_type");
