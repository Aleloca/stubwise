-- Area 8, fetta 3: Support, le conversazioni coi clienti nell'app.
-- Il `notification_kind` di Support, in uno statement a sé e mai usato nello
-- stesso batch (il migratore gira in UNA transazione: CLAUDE.md).
-- La premessa (maintainer, 14 nov 2026): il team non scrive MAI al cliente
-- nel widget; una conversazione con un esito è chiusa, e un messaggio nuovo
-- del cliente ne apre la successiva (`continued_in_id`).
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'support.request';
--> statement-breakpoint
-- Il codice delle conversazioni (`<PRJ>-S<n>`): un contatore per progetto,
-- dato dal trigger a OGNI conversazione nuova, mai riusato. Le conversazioni
-- di prima sono numerate per data di creazione (e id), come le richieste
-- (0121).
ALTER TABLE "projects" ADD COLUMN "next_support_number" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "widget_conversations" ADD COLUMN "number" integer;
--> statement-breakpoint
UPDATE "widget_conversations" c SET "number" = r."n"
FROM (
	SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "created_at", "id") AS "n"
	FROM "widget_conversations"
) r
WHERE r."id" = c."id";
--> statement-breakpoint
UPDATE "projects" p SET "next_support_number" =
	coalesce((SELECT max(c."number") FROM "widget_conversations" c WHERE c."project_id" = p."id"), 0) + 1;
--> statement-breakpoint
ALTER TABLE "widget_conversations" ALTER COLUMN "number" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "widget_conversations" ADD CONSTRAINT "widget_conversations_project_number_unique" UNIQUE ("project_id", "number");
--> statement-breakpoint
-- Il numero dopo del progetto, sotto il lock della sua riga. Un `number`
-- passato all'insert è IGNORATO (lascerebbe il contatore indietro). Una
-- conversazione non cambia progetto: solo all'insert.
CREATE FUNCTION widget_conversations_assign_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	UPDATE "projects" SET "next_support_number" = "next_support_number" + 1
	WHERE "id" = NEW."project_id"
	RETURNING "next_support_number" - 1 INTO NEW."number";
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "widget_conversations_assign_number" BEFORE INSERT ON "widget_conversations"
	FOR EACH ROW EXECUTE FUNCTION widget_conversations_assign_number();
--> statement-breakpoint
-- Il canale (F3-4): il widget, o il server MCP in modalità collaboratore.
ALTER TABLE "widget_conversations" ADD COLUMN "channel" text DEFAULT 'widget' NOT NULL;
--> statement-breakpoint
ALTER TABLE "widget_conversations" ADD CONSTRAINT "widget_conversations_channel_chk" CHECK ("channel" in ('widget', 'mcp'));
--> statement-breakpoint
-- Il canale `mcp`: la conversazione arriva con la richiesta, e il worker la
-- ritrova dal job d'intake (il payload del job è `strict`: un campo nuovo lo
-- farebbe rifiutare a un worker più vecchio).
ALTER TABLE "widget_conversations" ADD COLUMN "intake_job_id" uuid REFERENCES "backlog_jobs"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "widget_conversations_intake_job_idx" ON "widget_conversations" USING btree ("intake_job_id") WHERE "intake_job_id" IS NOT NULL;
--> statement-breakpoint
-- Il giudizio sul triage di una conversazione senza esito (F3-2, G-1): lo dà
-- il controllo del worker dopo il silenzio (`by_user_id` null) o una persona
-- con «Non conclusa». Vale finché non arriva un messaggio del cliente più
-- recente (lo stato si deriva). `triage_checked_at`: l'ultimo controllo, uno
-- per silenzio.
ALTER TABLE "widget_conversations" ADD COLUMN "triage_outcome" text;
--> statement-breakpoint
ALTER TABLE "widget_conversations" ADD CONSTRAINT "widget_conversations_triage_outcome_chk" CHECK ("triage_outcome" in ('concluded', 'not_concluded'));
--> statement-breakpoint
ALTER TABLE "widget_conversations" ADD COLUMN "triage_outcome_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "widget_conversations" ADD COLUMN "triage_outcome_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "widget_conversations" ADD COLUMN "triage_checked_at" timestamp with time zone;
--> statement-breakpoint
-- La successiva di una conversazione chiusa (S17): un messaggio del cliente
-- su una conversazione con un esito va qui.
ALTER TABLE "widget_conversations" ADD COLUMN "continued_in_id" uuid REFERENCES "widget_conversations"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- I siti ammessi del widget (S16): vuoto = qualunque sito (i widget di prima).
ALTER TABLE "widgets" ADD COLUMN "allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
-- La risposta di una persona a un collaboratore (SOLO canale `mcp`: al
-- cliente del widget il team non scrive): `role` = 'team' (testo libero,
-- nessun enum) e il suo autore.
ALTER TABLE "widget_messages" ADD COLUMN "author_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- L'id che il client dà a una risposta («Send to customer»): un doppio invio,
-- o un «Retry» dopo un timeout, non manda due messaggi.
ALTER TABLE "widget_messages" ADD COLUMN "client_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "widget_messages_client_id_idx" ON "widget_messages" USING btree ("conversation_id", "client_id") WHERE "client_id" IS NOT NULL;
--> statement-breakpoint
-- La richiesta nata da una conversazione.
ALTER TABLE "backlog_items" ADD COLUMN "support_conversation_id" uuid REFERENCES "widget_conversations"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "backlog_items_support_conversation_idx" ON "backlog_items" USING btree ("support_conversation_id") WHERE "support_conversation_id" IS NOT NULL;
--> statement-breakpoint
-- L'operazione AI di Support nel CHECK di `agent_runs` e di
-- `ai_model_settings` (testo + CHECK, mai un enum: `AI_OPERATIONS`).
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_operation_chk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'automation_step', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe', 'support_triage_check'));
--> statement-breakpoint
ALTER TABLE "ai_model_settings" DROP CONSTRAINT "ai_model_settings_operation_chk";
--> statement-breakpoint
ALTER TABLE "ai_model_settings" ADD CONSTRAINT "ai_model_settings_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'mail_draft', 'meeting_summary', 'automation_step', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe', 'support_triage_check'));
--> statement-breakpoint
-- Il permesso `support.manage` (S-7: aprire la richiesta da una
-- conversazione, segnarla non conclusa, rispondere ai collaboratori): ai preset Project Lead, Developer e
-- Legacy Member e a OGNI ruolo di progetto che conteneva già tutti i
-- permessi di uno di quei preset (la regola della 0135,
-- `docs/invariants/permissions.md`). Prima i ruoli personalizzati, poi i
-- preset (i loro permessi di prima sono il confronto). Contributor e Viewer
-- nascono senza; il full admin l'ha implicito.
UPDATE "roles" AS r
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest(r."permissions" || ARRAY['support.manage']) AS p)
WHERE r."scope" = 'project'
	AND r."preset_key" IS NULL
	AND EXISTS (
		SELECT 1 FROM "roles" pr
		WHERE pr."preset_key" IN ('project_lead', 'developer', 'legacy_member')
			AND r."permissions" @> pr."permissions"
	);
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest("permissions" || ARRAY['support.manage']) AS p)
WHERE "preset_key" IN ('project_lead', 'developer', 'legacy_member');
