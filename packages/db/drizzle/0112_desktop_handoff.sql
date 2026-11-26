-- Integrazione area 2 (9 nov 2026): il login del desktop passa dal browser
-- di sistema. Il browser, con una sessione COMPLETA e un clic di conferma,
-- chiede un codice monouso legato a un challenge PKCE; il desktop lo scambia
-- col suo token (`personal_access_tokens.kind = 'desktop'`). Del codice si
-- conserva solo lo SHA-256; vale 2 minuti e una volta sola.
CREATE TABLE "desktop_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"code_hash" text NOT NULL,
	"code_challenge" text NOT NULL,
	"device_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "desktop_handoffs_code_hash_unique" UNIQUE ("code_hash")
);
--> statement-breakpoint
CREATE INDEX "desktop_handoffs_user_idx" ON "desktop_handoffs" ("user_id");
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" DROP CONSTRAINT "personal_access_tokens_kind_chk";
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_kind_chk"
	CHECK ("personal_access_tokens"."kind" in ('manual', 'mobile', 'desktop'));
