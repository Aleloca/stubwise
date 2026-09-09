-- Fase 7 — workflow guidato web per non-tecnici. Tutto additivo, nessun enum
-- nuovo (nessun ADD VALUE): un solo batch.
--
-- 1) Pre-approvazione del piano: un maintainer può approvare in anticipo il
--    piano CORRENTE di un ticket, così un operatore (member) può far partire
--    il fix senza fermarsi sul gate. `plan_approved_digest` è lo SHA-256 del
--    piano al momento dell'approvazione (planDigest, packages/db/src/plan-digest.ts):
--    il gate confronta il digest col piano ATTUALE, quindi l'approvazione
--    decade da sola a ogni riscrittura del piano.
ALTER TABLE "tickets"
  ADD COLUMN "plan_approved_at" timestamp with time zone,
  ADD COLUMN "plan_approved_by_user_id" uuid,
  ADD COLUMN "plan_approved_digest" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_plan_approved_by_user_id_users_id_fk" FOREIGN KEY ("plan_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- 2) Riassunto del fallimento di un job: stessa forma di plan_summary/pr_summary,
--    generato best-effort quando il job entra in "failed".
ALTER TABLE "ai_jobs" ADD COLUMN "failure_summary" text;--> statement-breakpoint

-- 3) Domande a bottoni ancorate alla voce di backlog (gemella di
--    agent_questions, ma senza job/ticket: una voce non convertita non ha né
--    l'uno né l'altro). "Non ora" (dismissed_at) è un'uscita obbligatoria in
--    più rispetto ad agent_questions: qui una domanda può chiudersi senza
--    risposta.
CREATE TABLE "backlog_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backlog_item_id" uuid NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"recommended_index" integer,
	"allow_free_text" boolean DEFAULT true NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answer" jsonb,
	"answered_at" timestamp with time zone,
	"answered_by_user_id" uuid,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "backlog_questions" ADD CONSTRAINT "backlog_questions_backlog_item_id_backlog_items_id_fk" FOREIGN KEY ("backlog_item_id") REFERENCES "public"."backlog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlog_questions" ADD CONSTRAINT "backlog_questions_answered_by_user_id_users_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Una sola domanda APERTA per voce: né risposta né "non ora". Indice unico
-- PARZIALE, come agent_questions_open_job_unique: le domande chiuse (in un
-- modo o nell'altro) non vi partecipano, la conversazione può accumularne
-- più di una nel tempo ma mai due aperte insieme.
CREATE UNIQUE INDEX "backlog_questions_open_item_unique" ON "backlog_questions" USING btree ("backlog_item_id") WHERE answered_at IS NULL AND dismissed_at IS NULL;--> statement-breakpoint
CREATE INDEX "backlog_questions_item_idx" ON "backlog_questions" USING btree ("backlog_item_id","asked_at");--> statement-breakpoint
-- Una domanda è risposta se e solo se ha una risposta (indipendente da
-- dismissed_at: "non ora" non è una risposta, answer resta null).
ALTER TABLE "backlog_questions" ADD CONSTRAINT "backlog_questions_answer_chk" CHECK ((answer IS NULL) = (answered_at IS NULL));
