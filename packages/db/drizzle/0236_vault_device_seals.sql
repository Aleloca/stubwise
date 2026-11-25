-- Lotto 10, voce 2: la cassaforte dal desktop, la chiave del Mac
-- (`docs/plans/2026-11-24-cassaforte-desktop-design.md` §6). Il server tiene
-- solo buste opache e pubbliche: niente di questo si decifra qui.
--
-- L'associazione di un Mac: la chiede il main COL SUO PAT desktop, e il
-- browser la completa con la passkey. Solo l'hash dello `state`; 10 minuti,
-- uso singolo. `id` è il `deviceId` dell'AAD del sigillo, e diventa l'id del
-- sigillo.
CREATE TABLE "vault_device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"pat_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"device_public_key" text NOT NULL,
	"device_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "vault_device_pairings_state_hash_unique" UNIQUE("state_hash")
);--> statement-breakpoint
ALTER TABLE "vault_device_pairings" ADD CONSTRAINT "vault_device_pairings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_device_pairings" ADD CONSTRAINT "vault_device_pairings_pat_id_personal_access_tokens_id_fk" FOREIGN KEY ("pat_id") REFERENCES "public"."personal_access_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_device_pairings_pat_id_idx" ON "vault_device_pairings" USING btree ("pat_id");--> statement-breakpoint
-- Il sigillo del dispositivo: la privata di persona avvolta per la pubblica
-- del Mac (`sealForDevice`). Legato alla persona, alla chiave di persona
-- CONFERMATA che sigilla e al PAT desktop; uno vivo per PAT. La revoca è un
-- `revoked_at` (resta la riga, per il registro), e vale anche a LETTURA:
-- chiave non più quella confermata attuale, PAT sparito (cascata).
CREATE TABLE "vault_device_seals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"person_key_id" uuid NOT NULL,
	"pat_id" uuid NOT NULL,
	"device_public_key" text NOT NULL,
	"seal" text NOT NULL,
	"device_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "vault_device_seals_revoked_chk" CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
	CONSTRAINT "vault_device_seals_reason_chk" CHECK (revoked_reason IS NULL OR revoked_reason IN ('forgotten', 'removed', 'admin_removed', 'replaced'))
);--> statement-breakpoint
ALTER TABLE "vault_device_seals" ADD CONSTRAINT "vault_device_seals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_device_seals" ADD CONSTRAINT "vault_device_seals_person_key_id_vault_person_keys_id_fk" FOREIGN KEY ("person_key_id") REFERENCES "public"."vault_person_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_device_seals" ADD CONSTRAINT "vault_device_seals_pat_id_personal_access_tokens_id_fk" FOREIGN KEY ("pat_id") REFERENCES "public"."personal_access_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vault_device_seals_one_live_per_pat_idx" ON "vault_device_seals" USING btree ("pat_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "vault_device_seals_user_id_idx" ON "vault_device_seals" USING btree ("user_id");--> statement-breakpoint
-- Da dove si è letta una password (D-8): il browser o un Mac, e quale.
ALTER TABLE "credential_access_log" ADD COLUMN "via" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_access_log" ADD COLUMN "device_seal_id" uuid;--> statement-breakpoint
ALTER TABLE "credential_access_log" ADD CONSTRAINT "credential_access_log_device_seal_id_vault_device_seals_id_fk" FOREIGN KEY ("device_seal_id") REFERENCES "public"."vault_device_seals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_access_log" ADD CONSTRAINT "credential_access_log_via_chk" CHECK (via IN ('browser', 'desktop'));--> statement-breakpoint
-- La sfida della propria chiave chiesta dal desktop: legata al PAT invece
-- che alla sessione. Una delle due, mai entrambe; il PAT solo per `actor`
-- (il recupero col kit resta del browser).
ALTER TABLE "vault_recovery_challenges" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_recovery_challenges" ADD COLUMN "pat_id" uuid;--> statement-breakpoint
ALTER TABLE "vault_recovery_challenges" ADD CONSTRAINT "vault_recovery_challenges_pat_id_personal_access_tokens_id_fk" FOREIGN KEY ("pat_id") REFERENCES "public"."personal_access_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_recovery_challenges" ADD CONSTRAINT "vault_recovery_challenges_holder_chk" CHECK ((session_id IS NULL) <> (pat_id IS NULL) AND (pat_id IS NULL OR kind = 'actor'));
