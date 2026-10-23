-- Sfide di possesso del kit di recupero (23 ott 2026, Task 7 della
-- cassaforte). Il server non può sapere se chi usa le rotte di recupero ha
-- davvero il kit: gli manda un segreto casuale cifrato per la chiave
-- PUBBLICA di recupero, e accetta solo chi lo rimanda in chiaro. Qui resta
-- solo l'HASH del segreto, legato a chi l'ha chiesto e alla sua sessione,
-- con scadenza breve e uso singolo (`used_at`).
CREATE TABLE "vault_recovery_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "vault_recovery_challenges" ADD CONSTRAINT "vault_recovery_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "vault_recovery_challenges" ADD CONSTRAINT "vault_recovery_challenges_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "vault_recovery_challenges_expires_at_idx" ON "vault_recovery_challenges" USING btree ("expires_at");
