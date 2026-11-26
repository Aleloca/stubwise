-- Chat con Claude, fetta 1 (10 nov 2026): la conversazione libera è una
-- sessione dell'agente di kind `free` (a turni come il refinement), più la riga
-- di `claude_conversations` con ciò che la sessione non ha: autore (la
-- conversazione è PRIVATA), titolo, archivio, contesto, id della conversazione
-- del CLI per `--resume`. Additiva: nessuna riga esistente cambia.
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_kind_chk";
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_kind_chk" CHECK (kind in ('ai_job','pr_review','backlog_item','backlog_job','doc_generation','email_message','project_brief','daily_report','backlog_refine','free'));
--> statement-breakpoint
CREATE TABLE "claude_conversations" (
	"session_id" uuid PRIMARY KEY NOT NULL REFERENCES "agent_sessions"("id") ON DELETE CASCADE,
	"owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"title" text DEFAULT '' NOT NULL,
	"archived_at" timestamp with time zone,
	"context_ref" jsonb,
	"cli_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "claude_conversations_owner_idx" ON "claude_conversations" USING btree ("owner_id","updated_at");
