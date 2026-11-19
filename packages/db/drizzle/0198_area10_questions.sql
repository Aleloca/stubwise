-- Area 10, F2 (19 nov 2026): le domande a scelta di Claude nella
-- conversazione libera e il segno «via Claude» sulle versioni delle
-- automazioni.
--
-- 1) Il tipo `question` fra gli eventi della sessione: porta solo l'id della
--    domanda, testo e opzioni si leggono dalla tabella (`claude-actions.md`,
--    «Gli eventi strutturati li scrive il server»).
ALTER TABLE "agent_session_events" DROP CONSTRAINT "agent_session_events_type_chk";
--> statement-breakpoint
ALTER TABLE "agent_session_events" ADD CONSTRAINT "agent_session_events_type_chk" CHECK (type in ('segment_start','assistant_text','tool_use','tool_result','input','turn_end','segment_end','proposal','actions_executed','question'));
--> statement-breakpoint
-- 2) La domanda: UNA per turno (l'input che apre il turno), la gemella di
--    `chat_claude_questions` per le conversazioni che non stanno in un canale.
--    Risposta: l'indice di un'opzione o un testo, chi e quando, insieme.
CREATE TABLE "claude_conversation_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL REFERENCES "agent_sessions"("id") ON DELETE CASCADE,
	"input_id" uuid NOT NULL,
	"text" text NOT NULL,
	"options" jsonb NOT NULL,
	"answer_option_index" integer,
	"answer_text" text,
	"answered_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"answered_at" timestamp with time zone,
	-- L'evento `question` della domanda: chi legge una pubblica vede solo le
	-- domande prima del seguito privato, come le proposte (`claude_proposals.event_id`).
	"event_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_conversation_questions_answer_chk" CHECK (("answered_at" is null) = ("answer_option_index" is null and "answer_text" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "claude_conversation_questions_turn_idx" ON "claude_conversation_questions" USING btree ("session_id","input_id");
--> statement-breakpoint
-- 3) Una versione salvata da Claude (`createAutomation`, `saveAutomationDraft`)
--    porta la sua azione, dalla stessa variabile di transazione della 0131 e
--    della 0195 che SOLO l'esecutore delle azioni di Claude imposta.
ALTER TABLE "automation_versions" ADD COLUMN "via_claude_action_id" uuid DEFAULT nullif(current_setting('stubwise.via_claude_action_id', true), '')::uuid;
