-- DA SOLA: il migratore esegue il batch in una transazione e Postgres non
-- permette di usare un valore enum aggiunto nella stessa (vedi CLAUDE.md).
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'request.created';
