-- Tipo del personal access token (21 ott 2026): `mobile` per quelli emessi da
-- /mobile-login, `manual` per quelli creati a mano (MCP, Claude Code, script).
-- Serve al reset e al cambio della password, che revocano i soli token
-- dell'app. Testo + CHECK e non un enum: niente ALTER TYPE nel batch.
ALTER TABLE "personal_access_tokens" ADD COLUMN "kind" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_kind_chk" CHECK ("personal_access_tokens"."kind" in ('manual', 'mobile'));--> statement-breakpoint
-- Backfill: prima di questa colonna l'unico segnale era il nome che
-- /mobile-login compone, `Mobile · <device>`.
UPDATE "personal_access_tokens" SET "kind" = 'mobile' WHERE "name" LIKE 'Mobile · %';
