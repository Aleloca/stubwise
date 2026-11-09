-- Integrazione area 2, fetta 1 (9 nov 2026): decisione chiesta, decisione
-- risposta, attività di una task seguita.
--
-- DA SOLI, in un file a sé: il migratore esegue il batch pendente in UNA
-- transazione (0107–0109 sono nello stesso batch) e Postgres non permette di
-- usare un valore enum aggiunto nella stessa. Nessuno statement del batch li
-- usa: li scrive il server, dopo il commit.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'decision.requested';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'decision.answered';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'ticket.activity';
