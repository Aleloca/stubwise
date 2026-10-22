-- Fase permessi (22 ott 2026): una proposta dalla posta PASSATA al progetto
-- dal proprietario della casella diventa una card per i decisori del progetto
-- (`google.proposal_handed`, audience `project_deciders`).
--
-- DA SOLA, e in un file a sé: il migratore esegue il batch pendente in UNA
-- transazione (la 0097 è nello stesso batch) e Postgres non permette di usare
-- un valore enum aggiunto nella stessa. Nessuno statement del batch lo usa:
-- lo scrive il server, al primo «Passa al progetto», dopo il commit.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'google.proposal_handed';
