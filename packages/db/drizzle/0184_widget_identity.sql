-- Area 8, «L'API per i siti» (16 nov 2026): il cliente segue le sue richieste
-- sul sito che ospita il widget. Il sito ne FIRMA l'identità (JWT HS256) col
-- segreto d'identità del widget, cifrato con la chiave d'istanza; una
-- conversazione aperta con un token valido è «verificata», e solo quelle
-- entrano nella lettura. Piano:
-- docs/plans/2026-11-15-integrazione-area8-api-siti-plan.md.
ALTER TABLE "widgets" ADD COLUMN "identity_secret_encrypted" text;
--> statement-breakpoint
ALTER TABLE "widgets" ADD COLUMN "identity_secret_rotated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "widgets" ADD COLUMN "identity_required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "widget_conversations" ADD COLUMN "identity_verified" boolean DEFAULT false NOT NULL;
