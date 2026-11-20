-- Area 10, F7 (S0, D-1 = a, D-5 = a): il tipo `capabilities` fra gli eventi
-- della sessione — l'elenco di ciò che Claude sa fare per chi chiede. Lo
-- scrive il worker con gli id che gli dà il server, mai il modello
-- (`docs/invariants/claude-actions.md`). E la tabella dei «Not now» delle
-- righe «Claude can help you…»: per persona, per tipo e per oggetto.
ALTER TABLE "agent_session_events" DROP CONSTRAINT "agent_session_events_type_chk";
--> statement-breakpoint
ALTER TABLE "agent_session_events" ADD CONSTRAINT "agent_session_events_type_chk" CHECK (type in ('segment_start','assistant_text','tool_use','tool_result','input','turn_end','segment_end','proposal','actions_executed','question','aside','capabilities'));
--> statement-breakpoint
CREATE TABLE "claude_suggestion_dismissals" (
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"object_id" text DEFAULT '' NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_suggestion_dismissals_pk" PRIMARY KEY ("user_id","kind","object_id")
);
