-- Regola di automazione per il tipo `review`: auto_fix SPENTO di default.
-- È l'anti-loop: il ticket creato dall'automazione PR Review non deve
-- innescare la pipeline di fix.
--
-- Migrazione SEPARATA dalla 0037 (che aggiunge 'review' a ticket_type):
-- Postgres non permette di USARE un valore enum aggiunto nella stessa
-- transazione ("unsafe use of new value of enum type") e il migratore esegue
-- ogni file .sql in una transazione propria.
INSERT INTO "automation_rules" ("type", "auto_fix", "max_effort")
VALUES ('review', false, 3)
ON CONFLICT ("type") DO NOTHING;
