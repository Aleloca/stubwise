-- Integrazione area 2, fetta 1 (9 nov 2026, decisione dell'orchestrazione):
-- la scadenza di una task, campo della testata e della riga elenco del
-- prototipo. Una data (non un istante): nessun fuso.
ALTER TABLE "tickets" ADD COLUMN "due_date" date;
