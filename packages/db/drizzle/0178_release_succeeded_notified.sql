-- Area 8, F2 (S4): l'avviso `release.succeeded` UNA volta per rilascio, come
-- `failed_notified_at` per `release.failed`.
ALTER TABLE "releases" ADD COLUMN "succeeded_notified_at" timestamp with time zone;
