-- Chat con Claude, fetta 1 (10 nov 2026): il token di UN turno con cui i tool
-- di lettura di Claude chiamano il server come l'autore della conversazione.
-- Lo emette il worker, solo l'hash a riposo, scadenza breve, revoca a fine
-- turno; CASCADE dalla sessione e dall'utente. Additiva.
CREATE TABLE "claude_chat_tool_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL REFERENCES "agent_sessions"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "claude_chat_tool_tokens_expires_idx" ON "claude_chat_tool_tokens" USING btree ("expires_at");
