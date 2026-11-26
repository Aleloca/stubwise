-- Lotto 7, voce 1: l'esito delle azioni del renderer (`pageAction`,
-- `fillField`) di una proposta di Claude, per indice. Lo scrive solo chi ha
-- chiesto la proposta; nessuna riga = `pending`. Tabella nuova, nessun dato
-- esistente toccato.
CREATE TABLE "claude_page_outcomes" (
	"proposal_id" uuid NOT NULL,
	"action_index" integer NOT NULL,
	"status" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_page_outcomes_proposal_id_action_index_pk" PRIMARY KEY("proposal_id","action_index"),
	CONSTRAINT "claude_page_outcomes_status_chk" CHECK (status in ('done','failed','placed','waiting','undone','changed_after')),
	CONSTRAINT "claude_page_outcomes_index_chk" CHECK (action_index >= 0)
);
--> statement-breakpoint
ALTER TABLE "claude_page_outcomes" ADD CONSTRAINT "claude_page_outcomes_proposal_id_claude_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."claude_proposals"("id") ON DELETE cascade ON UPDATE no action;
