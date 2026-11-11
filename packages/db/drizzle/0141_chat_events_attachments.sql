-- Area 4, Chat, fetta 4 (11 nov 2026): gli eventi dei progetti nei canali e
-- gli allegati dei messaggi. Piano in
-- `docs/plans/2026-11-11-integrazione-area4-fetta4-plan.md`.
--
-- L'evento di un messaggio di SISTEMA: il tipo e l'oggetto. Il testo della
-- scheda si deriva a lettura (chi non vede la task legge il codice senza il
-- titolo), quindi il corpo resta vuoto. `event_pr_id`: la riga della PR per
-- `pr_opened`/`pr_merged` (numero e repository a lettura).
ALTER TABLE "chat_messages" ADD COLUMN "event_kind" text;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "event_ref_kind" text;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "event_ref_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "event_pr_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_event_pr_fk" FOREIGN KEY ("event_pr_id") REFERENCES "public"."ticket_repositories"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_event_chk" CHECK (
	("event_kind" is null and "event_ref_kind" is null and "event_ref_id" is null and "event_pr_id" is null)
	or (
		"kind" = 'system'
		and "event_kind" in ('release_page', 'pr_opened', 'pr_merged', 'milestone_reached', 'brief_ready', 'request_new', 'task_closed')
		and "event_ref_kind" in ('task', 'request', 'milestone', 'brief', 'release')
		and "event_ref_id" is not null
	)
);
--> statement-breakpoint
-- Gli allegati di un messaggio. Nascono «in sospeso» (`message_id` null),
-- caricati nel canale da chi scrive, e un suo messaggio di quel canale li
-- lega. Il binario sta nello storage (`storage_key`), mai nel DB né nell'API.
CREATE TABLE "chat_message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"message_id" uuid,
	"uploader_id" uuid,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_message_attachments" ADD CONSTRAINT "chat_message_attachments_channel_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_message_attachments" ADD CONSTRAINT "chat_message_attachments_message_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_message_attachments" ADD CONSTRAINT "chat_message_attachments_uploader_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_attachments_storage_key_idx" ON "chat_message_attachments" USING btree ("storage_key");
--> statement-breakpoint
CREATE INDEX "chat_message_attachments_message_idx" ON "chat_message_attachments" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX "chat_message_attachments_pending_idx" ON "chat_message_attachments" USING btree ("created_at") WHERE "message_id" IS NULL;
--> statement-breakpoint
-- Un evento del progetto: un messaggio di sistema in ogni canale del
-- progetto, non archiviato, che pubblica `p_kind`, e il NOTIFY dello stream
-- della Chat (`chat_channel`, lo stesso del server). Lo chiamano i trigger
-- qui sotto, nella transazione di chi scrive: coprono OGNI scrittore (rotte,
-- pipeline del worker, intake, webhook), come il «general» della 0135. I
-- NOTIFY uguali di una transazione Postgres li manda una volta sola.
CREATE FUNCTION "chat_publish_event"(p_project uuid, p_kind text, p_ref_kind text, p_ref_id uuid, p_pr uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
	ch uuid;
BEGIN
	FOR ch IN
		SELECT "id" FROM "chat_channels"
		WHERE "project_id" = p_project AND "kind" = 'project' AND "archived_at" IS NULL
			AND p_kind = ANY ("published_events")
	LOOP
		INSERT INTO "chat_messages" ("channel_id", "kind", "body", "event_kind", "event_ref_kind", "event_ref_id", "event_pr_id")
		VALUES (ch, 'system', '', p_kind, p_ref_kind, p_ref_id, p_pr);
		PERFORM pg_notify('chat_channel', json_build_object('channelId', ch)::text);
	END LOOP;
END;
$$;
--> statement-breakpoint
-- Una task che ENTRA nella famiglia «closed» (lo stato vero è `status_id`; il
-- trigger di sync lo scrive anche per chi scrive l'enum). Fra due stati chiusi
-- non ripubblica.
CREATE FUNCTION "chat_event_task_closed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF (SELECT "family" FROM "project_statuses" WHERE "id" = NEW."status_id") = 'closed'
		AND coalesce((SELECT "family" FROM "project_statuses" WHERE "id" = OLD."status_id"), '') <> 'closed' THEN
		PERFORM "chat_publish_event"(NEW."project_id", 'task_closed', 'task', NEW."id", NULL);
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tickets_chat_task_closed" AFTER UPDATE ON "tickets"
	FOR EACH ROW WHEN (OLD."status_id" IS DISTINCT FROM NEW."status_id")
	EXECUTE FUNCTION "chat_event_task_closed"();
--> statement-breakpoint
-- Una richiesta NUOVA: l'intake inserisce solo quando non fonde; una riga nata
-- già fusa non pubblica.
CREATE FUNCTION "chat_event_request_new"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "chat_publish_event"(NEW."project_id", 'request_new', 'request', NEW."id", NULL);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "backlog_items_chat_request_new" AFTER INSERT ON "backlog_items"
	FOR EACH ROW WHEN (NEW."merged_into_id" IS NULL)
	EXECUTE FUNCTION "chat_event_request_new"();
--> statement-breakpoint
CREATE FUNCTION "chat_event_milestone_reached"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "chat_publish_event"(NEW."project_id", 'milestone_reached', 'milestone', NEW."id", NULL);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "milestones_chat_reached" AFTER UPDATE ON "milestones"
	FOR EACH ROW WHEN (OLD."status" <> 'closed' AND NEW."status" = 'closed')
	EXECUTE FUNCTION "chat_event_milestone_reached"();
--> statement-breakpoint
-- Un brief settimanale pronto da leggere: `done` col testo (un `done` senza
-- testo, a provider mancante, non è da leggere).
CREATE FUNCTION "chat_event_brief_ready"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "chat_publish_event"(NEW."project_id", 'brief_ready', 'brief', NEW."id", NULL);
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_briefs_chat_ready" AFTER UPDATE ON "project_briefs"
	FOR EACH ROW WHEN (NEW."status" = 'done' AND NEW."summary" IS NOT NULL AND NOT (OLD."status" = 'done' AND OLD."summary" IS NOT NULL))
	EXECUTE FUNCTION "chat_event_brief_ready"();
--> statement-breakpoint
-- La PR di una task: aperta quando nasce l'URL (anche una riga nata con la PR,
-- l'adozione), mergiata quando lo stato diventa `merged`.
CREATE FUNCTION "chat_event_pr"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	project uuid;
BEGIN
	SELECT "project_id" INTO project FROM "tickets" WHERE "id" = NEW."ticket_id";
	IF NEW."pr_url" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."pr_url" IS NULL) THEN
		PERFORM "chat_publish_event"(project, 'pr_opened', 'task', NEW."ticket_id", NEW."id");
	END IF;
	IF NEW."pr_state" = 'merged' AND (TG_OP = 'INSERT' OR OLD."pr_state" <> 'merged') THEN
		PERFORM "chat_publish_event"(project, 'pr_merged', 'task', NEW."ticket_id", NEW."id");
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ticket_repositories_chat_pr" AFTER INSERT OR UPDATE ON "ticket_repositories"
	FOR EACH ROW EXECUTE FUNCTION "chat_event_pr"();
