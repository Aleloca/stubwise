-- Lotto 8, voce 3: più contesti per conversazione con Claude, al posto di
-- «l'ultimo vince». Il gruppo (al più 5, l'ultimo è il primario) e, per ogni
-- messaggio, il gruppo com'era all'invio. `context_ref` resta e si tiene
-- uguale all'ultimo (un server di prima lo legge ancora).
ALTER TABLE "claude_conversations" ADD COLUMN "context_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "claude_conversations" SET "context_refs" = jsonb_build_array("context_ref") WHERE "context_ref" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_session_inputs" ADD COLUMN "contexts" jsonb;
