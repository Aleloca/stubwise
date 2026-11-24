-- Lotto 8, voce 1: la conservazione delle esecuzioni delle automazioni. Le
-- FINITE da più di 90 giorni si COMPATTANO (il giro del worker, a lotti):
-- via registro, effetti, input, evento e variabili, il titolo diventa il nome
-- dell'automazione. Questa colonna lo segna; la riga resta per la numerazione,
-- `lastRunAt` e l'origine di ciò che l'esecuzione ha creato.
ALTER TABLE "automation_runs" ADD COLUMN "details_pruned_at" timestamp with time zone;
