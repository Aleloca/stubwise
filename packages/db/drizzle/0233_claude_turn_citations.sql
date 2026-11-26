-- Lotto 9, voce 1: le citazioni registrate sui messaggi di Claude. Ciò che
-- Claude ha LETTO col token del turno (un fatto del server, mai del modello);
-- a lettura vanno al `turn_end` del turno e si filtrano per chi guarda.
CREATE TABLE "claude_turn_citations" (
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"after_event_id" bigint NOT NULL,
	"code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_turn_citations_session_id_after_event_id_kind_ref_id_pk" PRIMARY KEY("session_id","after_event_id","kind","ref_id"),
	CONSTRAINT "claude_turn_citations_kind_chk" CHECK (kind in ('task','request','project','doc','drive'))
);
--> statement-breakpoint
ALTER TABLE "claude_turn_citations" ADD CONSTRAINT "claude_turn_citations_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
