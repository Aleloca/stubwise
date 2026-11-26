-- D4 della parità MCP (`docs/plans/2026-11-26-mcp-parita-design.md`): una
-- scrittura fatta da una persona DA Claude Code (l'MCP col suo PAT) porta
-- «via Claude Code» accanto all'autore, nella storia del ticket e nel
-- registro delle modifiche. `via_client` prende di DEFAULT la variabile di
-- transazione `stubwise.via_client`, che SOLO il server imposta all'inizio di
-- ogni transazione di una richiesta dell'MCP (`apps/server/src/mcp/via-client.ts`),
-- come `stubwise.via_claude_action_id` per il Claude dell'app (0131). L'autore
-- resta la persona. Le righe di prima restano a null: non si sa più da dove
-- sono arrivate. Colonne nullable con DEFAULT di una funzione: un ALTER senza
-- riscrittura della tabella.
ALTER TABLE "comments" ADD COLUMN "via_client" text DEFAULT nullif(current_setting('stubwise.via_client', true), '');
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_via_client_chk" CHECK ("via_client" IS NULL OR "via_client" = 'claude_code');
--> statement-breakpoint
ALTER TABLE "ticket_events" ADD COLUMN "via_client" text DEFAULT nullif(current_setting('stubwise.via_client', true), '');
--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_via_client_chk" CHECK ("via_client" IS NULL OR "via_client" = 'claude_code');
--> statement-breakpoint
ALTER TABLE "decision_requests" ADD COLUMN "via_client" text DEFAULT nullif(current_setting('stubwise.via_client', true), '');
--> statement-breakpoint
ALTER TABLE "decision_requests" ADD CONSTRAINT "decision_requests_via_client_chk" CHECK ("via_client" IS NULL OR "via_client" = 'claude_code');
--> statement-breakpoint
ALTER TABLE "change_log" ADD COLUMN "via_client" text DEFAULT nullif(current_setting('stubwise.via_client', true), '');
--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_via_client_chk" CHECK ("via_client" IS NULL OR "via_client" = 'claude_code');
--> statement-breakpoint
-- La colonna nuova entra nella tupla che un UPDATE annidato (l'azione di una
-- FK) non può cambiare: senza, quel ramo lascerebbe riscrivere da dove è
-- arrivata una voce.
CREATE OR REPLACE FUNCTION "change_log_append_only"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE'
		AND pg_trigger_depth() > 1
		AND (NEW."id", NEW."at", NEW."actor_email", NEW."actor_kind", NEW."type", NEW."subject_kind", NEW."subject_id", NEW."data", NEW."via_claude_action_id", NEW."undo_of_action_id", NEW."via_client")
			IS NOT DISTINCT FROM (OLD."id", OLD."at", OLD."actor_email", OLD."actor_kind", OLD."type", OLD."subject_kind", OLD."subject_id", OLD."data", OLD."via_claude_action_id", OLD."undo_of_action_id", OLD."via_client")
		AND (NEW."actor_user_id" IS NOT DISTINCT FROM OLD."actor_user_id" OR NEW."actor_user_id" IS NULL)
		AND (NEW."project_id" IS NOT DISTINCT FROM OLD."project_id" OR NEW."project_id" IS NULL)
	THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'change_log is append-only (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;
