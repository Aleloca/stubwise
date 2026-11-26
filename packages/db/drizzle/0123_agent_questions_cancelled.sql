-- Integrazione area 3, fetta 3b (10 nov 2026, review): una domanda dell'agente
-- chiusa senza risposta perché il lavoro è stato ANNULLATO («Annulla il
-- lavoro» su un job in `awaiting_input`). Distinta da una risposta: `answer`
-- e `answered_at` restano NULL, e chi legge la domanda sa che non è più aperta.
ALTER TABLE "agent_questions" ADD COLUMN "cancelled_at" timestamp with time zone;
