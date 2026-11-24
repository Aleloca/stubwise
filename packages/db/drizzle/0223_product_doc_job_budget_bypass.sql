-- Rimandi, lotto 4, review I-1 (D-7.1): un lavoro della doc di prodotto
-- chiesto A MANO da chi ha `plans.approve` nel progetto scavalca il budget del
-- mese finito, come `ai_jobs.manual_trigger`. Lo scrive il server alla
-- richiesta (prima versione, bozza di schermata, «aggiorna da fonte»); il
-- worker lo prende e lo esegue anche a budget finito. Default false: tutto il
-- resto (gli aggiornamenti automatici) si ferma come prima.
ALTER TABLE "product_doc_jobs" ADD COLUMN "budget_bypass" boolean DEFAULT false NOT NULL;
