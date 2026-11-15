-- Area 8, fetta 4b: le operazioni sui server attraverso l'agente e l'SSH di
-- sola lettura. Le regole: CLAUDE.md «Stubwise non fa deploy» e
-- docs/invariants/server-operations.md.
-- Il kind della diagnosi pronta, in uno statement a sé e mai usato nel batch.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'server.diagnosis_ready';
--> statement-breakpoint
-- Ciò che l'agente dichiara nell'ingest (versione, operazioni accese): una
-- dichiarazione, non un permesso.
ALTER TABLE "servers" ADD COLUMN "agent_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
-- I container di un ambiente su quel server (l'attribuzione, S5b). Vuoto = la
-- regola di fase 8: il container col nome dell'ambiente.
ALTER TABLE "environment_servers" ADD COLUMN "containers" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
-- La chiave Ed25519 d'istanza che firma i comandi: la privata cifrata a riposo
-- (come le credenziali), decifrata solo per firmare.
CREATE TABLE "instance_signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_key" text NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "instance_signing_keys_active_idx" ON "instance_signing_keys" USING btree ((true)) WHERE "retired_at" IS NULL;
--> statement-breakpoint
-- Le analisi per SERVER (F4b-4) e la loro attribuzione validata.
CREATE TABLE "server_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
	"episode_id" uuid REFERENCES "server_episodes"("id") ON DELETE SET NULL,
	"session_id" uuid REFERENCES "agent_sessions"("id") ON DELETE SET NULL,
	"started_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"blocked_by" text,
	"diagnosis" text,
	"attributed_project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
	"attribution" jsonb,
	"task_id" uuid REFERENCES "tickets"("id") ON DELETE SET NULL,
	"cost_usd" numeric(12, 6),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "server_analyses_status_chk" CHECK ("status" in ('running', 'done', 'failed', 'blocked')),
	CONSTRAINT "server_analyses_blocked_chk" CHECK ("blocked_by" is null or "blocked_by" in ('monthly_budget', 'cap', 'disabled'))
);
--> statement-breakpoint
-- UNA analisi per episodio; una manuale in corso per server.
CREATE UNIQUE INDEX "server_analyses_episode_idx" ON "server_analyses" USING btree ("episode_id") WHERE "episode_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "server_analyses_running_manual_idx" ON "server_analyses" USING btree ("server_id") WHERE "episode_id" IS NULL AND "status" = 'running';
--> statement-breakpoint
-- Il piano approvato: copia ESATTA dei passi, chi e quando. Un comando che
-- cambia si firma solo per un passo di un'approvazione non revocata.
CREATE TABLE "server_operation_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
	-- La task può sparire (eliminata, o col suo progetto): l'approvazione resta,
	-- perché il registro dei comandi la cita (review F4b, I5).
	"task_id" uuid REFERENCES "tickets"("id") ON DELETE SET NULL,
	"session_id" uuid REFERENCES "agent_sessions"("id") ON DELETE SET NULL,
	"steps" jsonb NOT NULL,
	"approved_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
-- Il registro: ogni comando dell'agente e ogni lettura SSH. `id` è il nonce.
CREATE TABLE "server_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
	"session_id" uuid REFERENCES "agent_sessions"("id") ON DELETE SET NULL,
	"analysis_id" uuid REFERENCES "server_analyses"("id") ON DELETE SET NULL,
	-- NO ACTION (controllata a fine statement), non RESTRICT: togliere un server
	-- toglie in cascata comandi e approvazioni nello stesso statement (review F4b, I5).
	"approval_id" uuid REFERENCES "server_operation_approvals"("id") ON DELETE NO ACTION,
	"step_index" integer,
	"via" text DEFAULT 'agent' NOT NULL,
	"action" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kind" text NOT NULL,
	"requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"signature" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"output" text,
	"exit_code" integer,
	"finished_at" timestamp with time zone,
	CONSTRAINT "server_commands_kind_chk" CHECK ("kind" in ('change', 'read')),
	CONSTRAINT "server_commands_via_chk" CHECK ("via" in ('agent', 'ssh')),
	CONSTRAINT "server_commands_status_chk" CHECK ("status" in ('pending', 'delivered', 'done', 'failed', 'expired', 'cancelled')),
	CONSTRAINT "server_commands_action_chk" CHECK (
		("via" = 'agent' and "action" in ('container.restart', 'container.stop', 'container.start', 'docker.prune', 'container.logs', 'container.state'))
		or ("via" = 'ssh' and "action" in ('processes', 'disk', 'memory', 'load', 'uptime', 'listening', 'failed_units', 'journal_errors'))
	),
	-- Un comando che CAMBIA esiste solo con un'approvazione, e solo via agente.
	CONSTRAINT "server_commands_change_approved_chk" CHECK ("kind" = 'read' or ("approval_id" is not null and "via" = 'agent' and "step_index" is not null)),
	-- Via SSH solo letture.
	CONSTRAINT "server_commands_ssh_read_chk" CHECK ("via" = 'agent' or "kind" = 'read')
);
--> statement-breakpoint
CREATE INDEX "server_commands_pending_idx" ON "server_commands" USING btree ("server_id", "issued_at") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX "server_commands_server_idx" ON "server_commands" USING btree ("server_id", "issued_at");
--> statement-breakpoint
-- L'accesso SSH di SOLA lettura (Q3 = b): la privata cifrata, mai in una risposta.
CREATE TABLE "server_ssh_access" (
	"server_id" uuid PRIMARY KEY NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
	"kind" text DEFAULT 'read' NOT NULL,
	"username" text DEFAULT 'stubwise-read' NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"host_key" text,
	"public_key" text NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"verify_result" jsonb,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_ssh_access_kind_chk" CHECK ("kind" = 'read'),
	CONSTRAINT "server_ssh_access_status_chk" CHECK ("status" in ('pending', 'verified', 'failed', 'revoked'))
);
--> statement-breakpoint
-- I tetti dell'analisi (F4b-2 = b, Impostazioni): null = i default del codice.
ALTER TABLE "instance_settings" ADD COLUMN "server_analysis_limits" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_kind_chk";
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_kind_chk" CHECK (kind in ('ai_job','pr_review','backlog_item','backlog_job','doc_generation','email_message','project_brief','daily_report','backlog_refine','free','chat_mention','server_analysis','server_fix'));
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_operation_chk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'automation_step', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe', 'support_triage_check', 'server_analysis', 'server_fix_plan'));
--> statement-breakpoint
ALTER TABLE "ai_model_settings" DROP CONSTRAINT "ai_model_settings_operation_chk";
--> statement-breakpoint
ALTER TABLE "ai_model_settings" ADD CONSTRAINT "ai_model_settings_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'automation_step', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe', 'support_triage_check', 'server_analysis', 'server_fix_plan'));
