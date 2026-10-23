-- Secondo fattore (23 ott 2026): l'avviso di sicurezza all'interessato
-- (`security.alert`, audience `account_owner`): 2FA azzerato, link di reset
-- della password generato, passkey aggiunta, codici di riserva rigenerati,
-- passo del secondo fattore bloccato dal tetto.
--
-- DA SOLA, e in un file a sé: il migratore esegue il batch pendente in UNA
-- transazione (la 0100 è nello stesso batch) e Postgres non permette di usare
-- un valore enum aggiunto nella stessa. Nessuno statement del batch lo usa:
-- lo scrive il server, al primo avviso, dopo il commit.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'security.alert';
