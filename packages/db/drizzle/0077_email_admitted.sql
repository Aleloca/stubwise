-- «La posta si legge per conversazione», parte B (design §2, Task 7): la
-- distinzione fra un messaggio AMMESSO e un messaggio di CONTESTO.
--
-- Quando l'ammissione fa passare un messaggio, il poller tira dentro anche i
-- suoi fratelli del thread: quelli entrano con `admitted = false` e servono
-- SOLO a dare contesto — non vengono mai classificati e non generano mai una
-- proposta, in nessun percorso.
--
-- ⚠️ Non è un valore nuovo di `status`, ed è una scelta: lo stato è un
-- PERCORSO (`new → classified → proposed → …`) che un messaggio di contesto
-- non fa mai. Sarebbe uno stato che non è uno stato.
--
-- `default true` è anche il backfill corretto: ogni riga che esiste oggi è
-- passata dal cancello dell'ammissione, perché prima di questa migrazione
-- era l'unico modo di entrare. Additiva, nessun ALTER TYPE, un solo batch.
ALTER TABLE "email_messages" ADD COLUMN "admitted" boolean NOT NULL DEFAULT true;--> statement-breakpoint

-- La fase 2 del tick cerca i messaggi da classificare per casella e stato
-- (`email_messages_account_status_idx`): ora deve anche escludere il
-- contesto. L'indice parziale copre esattamente quella query invece di
-- allargare quello esistente, che serve anche ad altre letture.
CREATE INDEX "email_messages_admitted_idx" ON "email_messages" ("account_id", "status") WHERE "admitted";
