-- Area 4, Chat, fetta 3 (10 nov 2026): @Claude nei canali. Piano:
-- `docs/plans/2026-11-10-integrazione-area4-fetta3-plan.md`.
--
-- Una risposta di @Claude è un messaggio `kind claude` (autore: l'utente di
-- sistema Claude, `called_by_id`: chi ha chiamato), legato alla SUA sessione
-- dell'agente (kind `chat_mention`, privata di chi chiama: gli eventi dei
-- tool li vede solo lui, D5) e al messaggio che chiamava.
-- Il kind nuovo delle sessioni: la chiamata a @Claude nella Chat.
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_kind_chk";
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_kind_chk" CHECK (kind in ('ai_job','pr_review','backlog_item','backlog_job','doc_generation','email_message','project_brief','daily_report','backlog_refine','free','chat_mention'));
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "agent_session_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_agent_session_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "call_message_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_call_message_fk" FOREIGN KEY ("call_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Lo stato della risposta: lavora, aspetta la risposta a una domanda, finita,
-- fallita (col motivo), fermata. Solo sulle risposte di Claude.
ALTER TABLE "chat_messages" ADD COLUMN "claude_state" text;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "claude_error" text;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "claude_retried" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_claude_state_chk" CHECK (
	("kind" = 'claude') = ("claude_state" is not null)
	AND ("claude_state" is null or "claude_state" in ('working', 'waiting', 'done', 'failed', 'stopped'))
	AND ("claude_error" is null or "claude_error" in ('forbidden', 'not_found', 'budget', 'other'))
);
--> statement-breakpoint
CREATE INDEX "chat_messages_agent_session_idx" ON "chat_messages" USING btree ("agent_session_id") WHERE "chat_messages"."agent_session_id" IS NOT NULL;
--> statement-breakpoint
-- La domanda che Claude fa a chi l'ha chiamato (R-G4): una per risposta, una
-- risposta sola. La scrive il worker (il tool `ask_question` del ponte), la
-- risposta il server (solo chi ha chiamato).
CREATE TABLE "chat_claude_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reply_message_id" uuid NOT NULL,
	"text" text NOT NULL,
	"options" jsonb NOT NULL,
	"answer_option_index" integer,
	"answer_text" text,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_claude_questions_answer_chk" CHECK (("answered_at" is null) = ("answered_by" is null))
);
--> statement-breakpoint
ALTER TABLE "chat_claude_questions" ADD CONSTRAINT "chat_claude_questions_reply_fk" FOREIGN KEY ("reply_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_claude_questions" ADD CONSTRAINT "chat_claude_questions_answered_by_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_claude_questions_reply_idx" ON "chat_claude_questions" USING btree ("reply_message_id");
