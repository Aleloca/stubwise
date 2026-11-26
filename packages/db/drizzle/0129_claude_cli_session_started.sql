-- Chat con Claude (correzione della review, 10 nov 2026): quando è nata la
-- sessione del CLI di una conversazione. Le sue trascrizioni non restano oltre
-- la potatura delle sessioni (14 giorni): passato quel tempo il worker la
-- scarta (cli_session_id null, trascrizioni via) e il turno dopo riparte col
-- prompt d'avvio e i messaggi rimasti.
ALTER TABLE "claude_conversations" ADD COLUMN "cli_session_started_at" timestamp with time zone;
