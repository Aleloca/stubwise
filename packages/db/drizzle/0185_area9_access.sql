-- Area 9, F1 (16 nov 2026): gli accessi. Piano:
-- docs/plans/2026-11-16-integrazione-area9-f1-plan.md, invarianti in
-- docs/invariants/permissions.md e identity.md.
-- I permessi personali di un membro (oltre al suo ruolo): cadono col membro.
-- Il permesso si valida nel codice, come `roles.permissions` (catalogo in
-- @stubwise/shared): nessun CHECK da aggiornare a ogni permesso nuovo.
CREATE TABLE "project_member_permissions" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted_by_user_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_member_permissions_pkey" PRIMARY KEY("project_id","user_id","permission")
);
--> statement-breakpoint
ALTER TABLE "project_member_permissions" ADD CONSTRAINT "project_member_permissions_member_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."project_members"("project_id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_member_permissions" ADD CONSTRAINT "project_member_permissions_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "project_member_permissions_user_idx" ON "project_member_permissions" USING btree ("user_id");
--> statement-breakpoint
-- Disattivare una persona (D-6).
ALTER TABLE "users" ADD COLUMN "deactivated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivated_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_deactivated_by_user_id_users_id_fk" FOREIGN KEY ("deactivated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Le mie sessioni (D-9).
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" timestamp with time zone;
--> statement-breakpoint
-- La foto (D-13): nel DB, perché lo storage può essere spento.
CREATE TABLE "user_avatars" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"bytes" bytea NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_avatars_type_chk" CHECK ("content_type" in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "user_avatars_size_chk" CHECK (octet_length("bytes") <= 524288)
);
--> statement-breakpoint
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Il cambio dell'email di login (D-13): al più una richiesta pendente.
CREATE TABLE "email_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"new_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "email_changes_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "email_changes" ADD CONSTRAINT "email_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "email_changes_one_pending_idx" ON "email_changes" USING btree ("user_id") WHERE "confirmed_at" IS NULL AND "cancelled_at" IS NULL;
