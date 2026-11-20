-- Area 10, F3 (S2, D-3 = a): il tipo `aside` fra gli eventi della sessione —
-- «Hypothesis» e «Details» del lavoro fermo. Lo scrive il worker, non il
-- modello: porta solo id e una chiave, e la riga si arricchisce a lettura con
-- la visibilità di chi guarda (`docs/invariants/claude-actions.md`).
ALTER TABLE "agent_session_events" DROP CONSTRAINT "agent_session_events_type_chk";
--> statement-breakpoint
ALTER TABLE "agent_session_events" ADD CONSTRAINT "agent_session_events_type_chk" CHECK (type in ('segment_start','assistant_text','tool_use','tool_result','input','turn_end','segment_end','proposal','actions_executed','question','aside'));
