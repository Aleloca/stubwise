-- Area 6, fetta 2: una task nata da una proposta della posta (la
-- classificazione nuova, `create_task`) è contenuto venuto da FUORI, come
-- quelle del widget o dell'SDK: per la regola «almeno B» della chat con Claude
-- (`EXTERNAL_TICKET_SOURCES`). Da sola: un valore d'enum non si usa nella
-- transazione che lo aggiunge (il batch di migrazioni è UNA transazione).
ALTER TYPE "ticket_source" ADD VALUE IF NOT EXISTS 'email';
