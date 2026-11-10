-- Integrazione area 3, fetta 3b (10 nov 2026): chi ha chiesto di ANNULLARE il
-- lavoro, e quando («Annulla il lavoro»). Lo scrive l'annullamento di un job
-- parcheggiato, che lo chiude subito; il 3b.1-bis lo userà anche come segnale
-- al worker per un job in esecuzione. La storia del ticket ne ricava
-- `run_cancelled` (con chi). Colonne additive, NULL per i job di prima.
ALTER TABLE "ai_jobs" ADD COLUMN "cancel_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "cancel_requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
