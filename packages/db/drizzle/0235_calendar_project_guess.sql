-- Lotto 9, voce 2 (a): il PROGETTO di un appuntamento con più progetti
-- candidati. Con la dottrina nuova (`MAIL_CLASSIFY_V2`) un evento SINGOLO i
-- cui invitati portano a PIÙ progetti non era una proposta; ora il worker
-- chiede al modello di sceglierne uno fra i candidati (UNA volta per evento),
-- e sotto la soglia nasce UNA «Quale progetto?» condivisa fra gli invitati.
--
-- La fase dei run che indovinano il progetto: l'operazione resta
-- `mail_classify` (nessun check nuovo su `agent_runs`/`ai_model_settings`),
-- la fase è sua così il tetto giornaliero della posta (`email_classify`) non
-- la conta. Valore d'enum in uno statement a sé e MAI usato in questo batch
-- (CLAUDE.md, «il batch gira in UNA transazione»): lo scrive il worker, dopo.
ALTER TYPE "public"."agent_run_phase" ADD VALUE 'calendar_classify';--> statement-breakpoint
-- L'esito della scelta del modello su QUESTA copia dell'evento:
-- `{ projectId: uuid|null, reason, at, by, candidates }` (null = non ancora
-- indovinato). Le copie dello stesso `ical_uid` nelle altre caselle lo
-- riusano invece di richiamare il modello. `project_guess_attempts`: i
-- tentativi falliti (errore del modello), con un tetto.
ALTER TABLE "calendar_events" ADD COLUMN "project_guess" jsonb;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "project_guess_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
-- La «Quale progetto?» del calendario: una proposta condivisa SENZA progetto
-- (`project_id` nullo) con i progetti fra cui scegliere. Quelle di progetto
-- restano com'erano (unique su `ical_uid` + progetto); per la domanda UNA per
-- appuntamento (indice unico parziale).
ALTER TABLE "calendar_proposals" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_proposals" ADD COLUMN "candidate_project_ids" uuid[];--> statement-breakpoint
ALTER TABLE "calendar_proposals" ADD CONSTRAINT "calendar_proposals_choose_chk" CHECK ((project_id IS NULL) = (candidate_project_ids IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_proposals_ical_uid_choose_unique" ON "calendar_proposals" USING btree ("ical_uid") WHERE project_id IS NULL;
