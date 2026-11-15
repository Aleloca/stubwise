-- Area 8, fetta 4b, S6: la correzione di un server nel progetto ATTRIBUITO
-- (docs/invariants/server-operations.md). Il piano sta QUI, mai nel piano del
-- ticket: `run_ticket` e la pipeline lo leggerebbero come un piano di codice
-- (F4b-7).
-- La sorgente della task, in uno statement a sé e mai usata nel batch.
ALTER TYPE "ticket_source" ADD VALUE IF NOT EXISTS 'server';
--> statement-breakpoint
CREATE TABLE "server_fixes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
	"server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"analysis_id" uuid REFERENCES "server_analyses"("id") ON DELETE SET NULL,
	"status" text DEFAULT 'none' NOT NULL,
	-- Il piano VALIDATO (`validateServerPlan`): azioni dell'insieme chiuso, mai testo libero.
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	-- Perché un piano proposto non è stato salvato (`schema`, `unknown_container`, …).
	"plan_error" text,
	"session_id" uuid REFERENCES "agent_sessions"("id") ON DELETE SET NULL,
	"approval_id" uuid REFERENCES "server_operation_approvals"("id") ON DELETE SET NULL,
	-- Il passo in corso e i comandi dei passi (indice → id del comando).
	"current_step" integer,
	"step_commands" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"rejected_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"rejected_at" timestamp with time zone,
	"rejection_note" text,
	"stopped_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "server_fixes_status_chk" CHECK ("status" in ('none', 'proposing', 'awaiting_approval', 'approved', 'running', 'done', 'failed', 'stopped', 'rejected')),
	-- In attesa d'approvazione c'è sempre un piano; un piano ha al più 10 passi.
	CONSTRAINT "server_fixes_awaiting_has_steps_chk" CHECK ("status" <> 'awaiting_approval' or jsonb_array_length("steps") between 1 and 10),
	-- Approvato o in esecuzione solo con un'approvazione.
	CONSTRAINT "server_fixes_approved_chk" CHECK ("status" not in ('approved', 'running') or "approval_id" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "server_fixes_task_idx" ON "server_fixes" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX "server_fixes_server_idx" ON "server_fixes" USING btree ("server_id");
