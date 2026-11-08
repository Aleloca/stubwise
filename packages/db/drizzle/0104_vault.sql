-- Cassaforte delle credenziali (23 ott 2026, design
-- `docs/plans/2026-10-23-cassaforte-credenziali-design.md`). Solo DDL: i
-- permessi `credentials.*` sono già nei preset (0103).
--
-- Il server tiene SOLO materiale cifrato o pubblico: la password di una
-- credenziale cifrata con la sua chiave, le copie di quella chiave cifrate per
-- ogni lettore (e per la chiave di recupero), le chiavi pubbliche delle
-- persone e le loro chiavi private sigillate con un segreto PRF della passkey.
--
-- `vault_settings` ha una riga sola (`id = 1`): esiste da quando la
-- cassaforte è stata attivata, e porta la chiave PUBBLICA di recupero.
CREATE TABLE "vault_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"recovery_public_key" text NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by_user_id" uuid,
	CONSTRAINT "vault_settings_singleton_chk" CHECK ("vault_settings"."id" = 1)
);
--> statement-breakpoint
-- Chiave di persona: al più UNA viva (pending o confirmed) per utente, le
-- altre restano come storia (`superseded` quando ricreata, `rejected`).
CREATE TABLE "vault_person_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"device" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_user_id" uuid,
	CONSTRAINT "vault_person_keys_status_chk" CHECK ("vault_person_keys"."status" in ('pending', 'confirmed', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vault_person_keys_one_live_idx" ON "vault_person_keys" USING btree ("user_id") WHERE "vault_person_keys"."status" in ('pending', 'confirmed');--> statement-breakpoint
-- La chiave privata di una persona, sigillata una volta per passkey (PRF).
CREATE TABLE "vault_person_key_seals" (
	"person_key_id" uuid NOT NULL,
	"passkey_id" uuid NOT NULL,
	"sealed_private_key" text NOT NULL,
	CONSTRAINT "vault_person_key_seals_pk" PRIMARY KEY("person_key_id","passkey_id")
);
--> statement-breakpoint
-- `id` lo genera il client: è l'AAD della password cifrata, quindi deve
-- esistere prima di cifrare. Solo `password_ciphertext` è cifrato.
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"service" text NOT NULL,
	"label" text,
	"url" text,
	"username" text,
	"notes" text,
	"password_ciphertext" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid
);
--> statement-breakpoint
CREATE INDEX "credentials_project_id_idx" ON "credentials" USING btree ("project_id");--> statement-breakpoint
-- Un invito a leggere: a una persona O a un ruolo di progetto, mai entrambi.
CREATE TABLE "credential_readers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid NOT NULL,
	"user_id" uuid,
	"role_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_readers_target_chk" CHECK (("credential_readers"."user_id" is null) <> ("credential_readers"."role_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "credential_readers_user_idx" ON "credential_readers" USING btree ("credential_id","user_id") WHERE "credential_readers"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "credential_readers_role_idx" ON "credential_readers" USING btree ("credential_id","role_id") WHERE "credential_readers"."role_id" is not null;--> statement-breakpoint
-- Copia della chiave di una credenziale per un destinatario: l'id di una
-- chiave di persona, o `recovery` per la chiave di recupero. Testo e non FK
-- per poter ospitare `recovery`: le copie delle chiavi superate le cancella
-- chi le supera, quelle dei lettori revocati `purgeStaleCopies`.
CREATE TABLE "credential_key_copies" (
	"credential_id" uuid NOT NULL,
	"recipient_id" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_key_copies_pk" PRIMARY KEY("credential_id","recipient_id")
);
--> statement-breakpoint
-- Registro degli accessi (mostra/copia). La fotografia in testo resta
-- leggibile quando credenziale o utente spariscono (FK a NULL).
CREATE TABLE "credential_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid,
	"project_id" uuid NOT NULL,
	"credential_snapshot" text NOT NULL,
	"user_id" uuid,
	"user_email" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_access_log_action_chk" CHECK ("credential_access_log"."action" in ('show', 'copy'))
);
--> statement-breakpoint
CREATE INDEX "credential_access_log_project_id_created_at_idx" ON "credential_access_log" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "vault_settings" ADD CONSTRAINT "vault_settings_activated_by_user_id_users_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_person_keys" ADD CONSTRAINT "vault_person_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_person_keys" ADD CONSTRAINT "vault_person_keys_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_person_key_seals" ADD CONSTRAINT "vault_person_key_seals_person_key_id_vault_person_keys_id_fk" FOREIGN KEY ("person_key_id") REFERENCES "public"."vault_person_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_person_key_seals" ADD CONSTRAINT "vault_person_key_seals_passkey_id_user_passkeys_id_fk" FOREIGN KEY ("passkey_id") REFERENCES "public"."user_passkeys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_readers" ADD CONSTRAINT "credential_readers_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_readers" ADD CONSTRAINT "credential_readers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_readers" ADD CONSTRAINT "credential_readers_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_readers" ADD CONSTRAINT "credential_readers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_key_copies" ADD CONSTRAINT "credential_key_copies_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_access_log" ADD CONSTRAINT "credential_access_log_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_access_log" ADD CONSTRAINT "credential_access_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_access_log" ADD CONSTRAINT "credential_access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
