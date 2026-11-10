-- Riconferma dal desktop (decisione del maintainer, 10 nov 2026): l'ultimo
-- secondo fattore fatto CON questo token, dentro l'app desktop
-- (`POST /api/auth/desktop-reauth`). Vale solo per i PAT `desktop`, per 10
-- minuti, come `sessions.second_factor_at`; null = mai, o azzerata (cambio
-- della password, azzeramento del 2FA). Un server di prima la ignora.
ALTER TABLE "personal_access_tokens" ADD COLUMN "second_factor_at" timestamp with time zone;
