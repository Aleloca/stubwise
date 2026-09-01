-- Pianificazione interattiva (fase 1): l'agente che pianifica un fix può
-- fermarsi e porre una domanda strutturata a un umano. Il job si parcheggia in
-- "awaiting_input" e riparte in "plan_continue" quando la risposta arriva,
-- riprendendo la sessione CLI salvata in `cli_session_id`.
-- ⚠️ I due ADD VALUE non vanno usati da nessun altro statement di questa
-- migrazione: il migratore esegue l'intero batch in UNA transazione e Postgres
-- non ammette l'uso di un valore enum aggiunto nella stessa transazione.
ALTER TYPE "public"."ai_job_status" ADD VALUE 'awaiting_input';--> statement-breakpoint
ALTER TYPE "public"."resume_mode" ADD VALUE 'plan_continue';--> statement-breakpoint
CREATE TABLE "agent_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"recommended_index" integer,
	"allow_free_text" boolean DEFAULT true NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer" jsonb,
	"answered_at" timestamp with time zone,
	"answered_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "cli_session_id" text;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_job_id_ai_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_answered_by_user_id_users_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Una sola domanda APERTA per job: è l'invariante del parcheggio (un job in
-- attesa ha esattamente una domanda a cui rispondere). Indice unico PARZIALE:
-- lo storico delle domande già risposte non vi partecipa, quindi i round
-- successivi si accumulano liberamente sullo stesso job.
CREATE UNIQUE INDEX "agent_questions_open_job_unique" ON "agent_questions" USING btree ("job_id") WHERE answered_at IS NULL;--> statement-breakpoint
-- Q&A di un ticket in ordine cronologico: è la timeline mostrata sulla pagina
-- del ticket e il blocco "Decisioni già prese" del fallback di ripresa.
CREATE INDEX "agent_questions_ticket_idx" ON "agent_questions" USING btree ("ticket_id","asked_at");--> statement-breakpoint
-- La risposta e il suo istante stanno o cadono insieme: una domanda è chiusa se
-- e solo se ha una risposta.
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_answer_chk" CHECK ((answer IS NULL) = (answered_at IS NULL));--> statement-breakpoint
-- Notifica della domanda: kind nuovo dell'inbox/webhook e suo toggle.
-- ⚠️ Come gli ADD VALUE in testa, 'job.awaiting_input' NON va usato da nessuno
-- statement di questa migrazione (stessa transazione).
ALTER TYPE "public"."notification_kind" ADD VALUE 'job.awaiting_input';--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "notify_awaiting_input" boolean DEFAULT true NOT NULL;
