-- Integrazione area 2, fetta 2 (9 nov 2026): avvisi di pianificazione e di
-- assegnazione, e tre eventi nuovi nell'attività di una task (settimana,
-- reparto, taglia: solo le scritture umane dell'app nuova).
--
-- DA SOLI, in un file a sé: il migratore esegue il batch pendente in UNA
-- transazione (0113–0114 sono nello stesso batch) e Postgres non permette di
-- usare un valore enum aggiunto nella stessa. Nessuno statement del batch li
-- usa: li scrive il server, dopo il commit.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'planning.changed';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'task.assigned';
--> statement-breakpoint
ALTER TYPE "ticket_event_kind" ADD VALUE IF NOT EXISTS 'planned_week_changed';
--> statement-breakpoint
ALTER TYPE "ticket_event_kind" ADD VALUE IF NOT EXISTS 'department_changed';
--> statement-breakpoint
ALTER TYPE "ticket_event_kind" ADD VALUE IF NOT EXISTS 'effort_changed';
