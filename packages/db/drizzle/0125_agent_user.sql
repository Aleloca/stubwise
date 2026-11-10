-- Integrazione area 3, fetta 3e (10 nov 2026, decisione del maintainer):
-- Claude come collega assegnabile. Un utente di SISTEMA per istanza
-- (`is_agent`), UNO solo (indice unico parziale), senza accesso: la password è
-- un segnaposto che non è un hash (nessuna verifica la accetta), e login,
-- sessioni e PAT lo rifiutano comunque per costruzione (`users.is_agent` nelle
-- query d'autenticazione del server). Nessuna notifica (`publishNotification`
-- lo toglie dai destinatari) né push né Slack. Il ruolo d'istanza è il preset
-- `User` (lo mette il trigger da `role = 'member'`): MAI il full admin, che lo
-- farebbe contare fra gli amministratori («resta sempre un full admin»).
-- L'email è in un dominio riservato (`.invalid`, RFC 2606): non riceve posta.
ALTER TABLE "users" ADD COLUMN "is_agent" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_agent" ON "users" ("is_agent") WHERE "is_agent";
--> statement-breakpoint
INSERT INTO "users" ("email", "password_hash", "role", "display_name", "notify_slack_dm", "notify_push", "is_agent")
VALUES ('claude@agent.stubwise.invalid', '!agent-no-login', 'member', 'Claude', false, false, true)
ON CONFLICT DO NOTHING;
