-- Area 7, fetta 1 (13 nov 2026): le Automations di PROGETTO — il motore, le
-- versioni, le esecuzioni, il registro, gli effetti idempotenti e l'outbox
-- degli eventi (`docs/plans/2026-11-12-integrazione-area7-fetta1-plan.md`,
-- «Il modello dei dati» e la correzione C1: il punto unico degli eventi è nel
-- DATABASE, trigger e non chiamate).
--
-- I valori d'enum nuovi (`ticket_source` `automation`, i quattro
-- `notification_kind`) stanno ognuno in uno statement a sé e NON si usano in
-- questo batch: il migratore gira tutto in UNA transazione, e Postgres non
-- permette di usare un valore d'enum nella transazione che l'ha aggiunto.
ALTER TYPE "ticket_source" ADD VALUE IF NOT EXISTS 'automation';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'automation.approval';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'automation.failed';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'automation.notify';
--> statement-breakpoint
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'automation.paused';
--> statement-breakpoint
CREATE TYPE "automation_status" AS ENUM ('draft', 'active', 'paused');
--> statement-breakpoint
CREATE TYPE "automation_paused_reason" AS ENUM ('manual', 'owner_lost_permission');
--> statement-breakpoint
CREATE TYPE "automation_run_status" AS ENUM ('running', 'waiting_approval', 'waiting_project', 'suspended', 'done', 'failed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "automation_run_origin" AS ENUM ('event', 'manual');
--> statement-breakpoint
CREATE TYPE "automation_event_kind" AS ENUM ('task_created', 'task_closed', 'request_created', 'request_converted', 'milestone_reached');
--> statement-breakpoint
CREATE TYPE "automation_effect_kind" AS ENUM ('task', 'milestone', 'request', 'notification');
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" uuid,
	"status" "automation_status" DEFAULT 'draft' NOT NULL,
	"paused_by" uuid,
	"paused_at" timestamp with time zone,
	"paused_reason" "automation_paused_reason",
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_via" text,
	-- Da quando è accesa (pubblicata o riaccesa): il consumatore ignora gli
	-- eventi nati prima, niente recupero retroattivo. Null se non è attiva.
	"active_since" timestamp with time zone,
	CONSTRAINT "automations_created_via_chk" CHECK ("created_via" IS NULL OR "created_via" = 'claude')
);
--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_paused_by_users_id_fk" FOREIGN KEY ("paused_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "automations_code_idx" ON "automations" USING btree ("code");
--> statement-breakpoint
CREATE UNIQUE INDEX "automations_project_seq_idx" ON "automations" USING btree ("project_id", "seq");
--> statement-breakpoint
-- La sequenza dei codici per progetto: `UPDATE … RETURNING` nella transazione
-- della creazione. Un codice non torna mai (una bozza eliminata lo consuma).
CREATE TABLE "automation_code_seqs" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"next" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_code_seqs" ADD CONSTRAINT "automation_code_seqs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"flow" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_by" uuid,
	"rev" integer DEFAULT 1 NOT NULL,
	"tested_rev" integer
);
--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_versions" ADD CONSTRAINT "automation_versions_saved_by_users_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_n_idx" ON "automation_versions" USING btree ("automation_id", "n");
--> statement-breakpoint
-- Al più UNA bozza per automazione.
CREATE UNIQUE INDEX "automation_versions_one_draft_idx" ON "automation_versions" USING btree ("automation_id") WHERE "published_at" IS NULL;
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"status" "automation_run_status" DEFAULT 'running' NOT NULL,
	"event" jsonb,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cursor" jsonb,
	"pending" jsonb,
	"project_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"parent_run_id" uuid,
	"origin" "automation_run_origin" NOT NULL,
	"started_by" uuid,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"due_at" timestamp with time zone DEFAULT now(),
	"claimed_at" timestamp with time zone,
	"claimed_by" text
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_parent_run_id_automation_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_n_idx" ON "automation_runs" USING btree ("automation_id", "n");
--> statement-breakpoint
-- La coda: le esecuzioni vive e dovute.
CREATE INDEX "automation_runs_due_idx" ON "automation_runs" USING btree ("due_at") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX "automation_runs_parent_idx" ON "automation_runs" USING btree ("parent_run_id") WHERE "parent_run_id" IS NOT NULL;
--> statement-breakpoint
-- La coda degli INPUT di un'esecuzione (approvazione, rifiuto, progetto
-- scelto, «Riprova», «Salta», riaccensione): li scrive il server, li consuma
-- l'esecutore del worker in ordine, uno alla volta, sotto il lease della
-- riga dell'esecuzione. Il server non fa mai avanzare il motore.
CREATE TABLE "automation_run_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"by_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "automation_run_inputs" ADD CONSTRAINT "automation_run_inputs_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_run_inputs" ADD CONSTRAINT "automation_run_inputs_by_id_users_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "automation_run_inputs_pending_idx" ON "automation_run_inputs" USING btree ("run_id", "created_at") WHERE "consumed_at" IS NULL;
--> statement-breakpoint
-- Il registro: mai riscritto (append-only).
CREATE TABLE "automation_run_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"step_id" text NOT NULL,
	"path" text NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"reason" text,
	"why" jsonb,
	"by_id" uuid,
	"effects" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_run_log" ADD CONSTRAINT "automation_run_log_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "automation_run_log" ADD CONSTRAINT "automation_run_log_by_id_users_id_fk" FOREIGN KEY ("by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_run_log_seq_idx" ON "automation_run_log" USING btree ("run_id", "seq");
--> statement-breakpoint
CREATE FUNCTION "automation_run_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'automation_run_log è append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "automation_run_log_no_update" BEFORE UPDATE ON "automation_run_log"
	FOR EACH ROW EXECUTE FUNCTION "automation_run_log_append_only"();
--> statement-breakpoint
-- Un effetto per passo e giro: la chiave d'idempotenza `<run>:<path>:<round>`.
CREATE TABLE "automation_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"path" text NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" "automation_effect_kind" NOT NULL,
	"object_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_effects" ADD CONSTRAINT "automation_effects_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "automation_effects_key_idx" ON "automation_effects" USING btree ("idempotency_key");
--> statement-breakpoint
-- L'outbox degli eventi (Q6, C1). La scrivono SOLO i trigger qui sotto, nella
-- transazione della scrittura che la genera: un rollback non lascia l'evento.
-- `txid` ordina gli eventi di una stessa transazione (la conversione prima
-- della task che ne nasce, Q5).
CREATE TABLE "automation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "automation_event_kind" NOT NULL,
	"project_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin_run_id" uuid,
	"txid" bigint DEFAULT txid_current() NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "automation_events_pending_idx" ON "automation_events" USING btree ("created_at") WHERE "consumed_at" IS NULL;
--> statement-breakpoint
-- Le righe create da un'esecuzione (l'origine si DERIVA a lettura da qui).
ALTER TABLE "tickets" ADD COLUMN "automation_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_automation_run_id_automation_runs_id_fk" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "automation_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_automation_run_id_automation_runs_id_fk" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backlog_items" ADD COLUMN "automation_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "backlog_items" ADD CONSTRAINT "backlog_items_automation_run_id_automation_runs_id_fk" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Il punto unico degli eventi. Due GUC LOCALI alla transazione:
-- - `stubwise.automation_events = 'off'` spegne la pubblicazione: la usano le
--   migrazioni, i backfill, gli import e i job di manutenzione che creano o
--   chiudono righe in massa (`docs/invariants/automations.md`);
-- - `stubwise.automation_run_id` è l'esecuzione che sta scrivendo (la imposta
--   SOLO il motore, `set_config(…, true)`): diventa `origin_run_id`, e la
--   catena si ferma da lì. Una persona o un altro processo non la impostano.
-- Il payload è una FOTOGRAFIA della riga al momento della scrittura; i campi
-- completi dell'inizio (codice, progetto, richiedente…) li compone il
-- consumatore, perché alcuni (i richiedenti di una voce) si scrivono DOPO la
-- riga, nella stessa transazione.
CREATE FUNCTION "automation_publish_event"(p_kind "automation_event_kind", p_project uuid, p_object uuid, p_payload jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	IF coalesce(current_setting('stubwise.automation_events', true), '') = 'off' THEN
		RETURN;
	END IF;
	INSERT INTO "automation_events" ("kind", "project_id", "object_id", "payload", "origin_run_id")
	VALUES (p_kind, p_project, p_object, p_payload, nullif(current_setting('stubwise.automation_run_id', true), '')::uuid);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "automation_event_task_created"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "automation_publish_event"('task_created', NEW."project_id", NEW."id",
		jsonb_build_object('number', NEW."number", 'title', NEW."title", 'statusId', NEW."status_id", 'assigneeId', NEW."assignee_id"));
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tickets_automation_task_created" AFTER INSERT ON "tickets"
	FOR EACH ROW EXECUTE FUNCTION "automation_event_task_created"();
--> statement-breakpoint
-- Una task che ENTRA nella famiglia «closed» (lo stato vero è `status_id`; il
-- trigger di sync lo scrive anche per chi scrive l'enum, e un BEFORE trigger
-- non conta per `UPDATE OF`: per questo il filtro è nel WHEN). Fra due stati
-- chiusi non ripubblica; riaperta e richiusa sì.
CREATE FUNCTION "automation_event_task_closed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF (SELECT "family" FROM "project_statuses" WHERE "id" = NEW."status_id") = 'closed'
		AND coalesce((SELECT "family" FROM "project_statuses" WHERE "id" = OLD."status_id"), '') <> 'closed' THEN
		PERFORM "automation_publish_event"('task_closed', NEW."project_id", NEW."id",
			jsonb_build_object('number', NEW."number", 'title', NEW."title", 'statusId', NEW."status_id", 'assigneeId', NEW."assignee_id"));
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tickets_automation_task_closed" AFTER UPDATE ON "tickets"
	FOR EACH ROW WHEN (OLD."status_id" IS DISTINCT FROM NEW."status_id")
	EXECUTE FUNCTION "automation_event_task_closed"();
--> statement-breakpoint
-- Una richiesta NUOVA: l'intake inserisce solo quando non fonde (la fusione
-- aggiorna una voce che c'è); una riga nata già fusa non pubblica.
CREATE FUNCTION "automation_event_request_created"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "automation_publish_event"('request_created', NEW."project_id", NEW."id",
		jsonb_build_object('number', NEW."number", 'title', NEW."title", 'urgency', NEW."urgency"));
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "backlog_items_automation_request_created" AFTER INSERT ON "backlog_items"
	FOR EACH ROW WHEN (NEW."merged_into_id" IS NULL)
	EXECUTE FUNCTION "automation_event_request_created"();
--> statement-breakpoint
-- La conversione: il legame `converted_to` fra la voce e la task che ne nasce
-- (`convertBacklogItem`, nella stessa transazione della task).
CREATE FUNCTION "automation_event_request_converted"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	item record;
BEGIN
	SELECT "project_id", "number", "title", "urgency" INTO item FROM "backlog_items" WHERE "id" = NEW."item_id";
	IF item IS NULL THEN
		RETURN NULL;
	END IF;
	PERFORM "automation_publish_event"('request_converted', item."project_id", NEW."item_id",
		jsonb_build_object('number', item."number", 'title', item."title", 'urgency', item."urgency", 'ticketId', NEW."ticket_id"));
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "backlog_item_tickets_automation_converted" AFTER INSERT ON "backlog_item_tickets"
	FOR EACH ROW WHEN (NEW."role" = 'converted_to')
	EXECUTE FUNCTION "automation_event_request_converted"();
--> statement-breakpoint
CREATE FUNCTION "automation_event_milestone_reached"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "automation_publish_event"('milestone_reached', NEW."project_id", NEW."id",
		jsonb_build_object('name', NEW."name", 'dueDate', NEW."due_date"));
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "milestones_automation_reached" AFTER UPDATE ON "milestones"
	FOR EACH ROW WHEN (OLD."status" <> 'closed' AND NEW."status" = 'closed')
	EXECUTE FUNCTION "automation_event_milestone_reached"();
--> statement-breakpoint
-- Il permesso `automations.manage`: al preset Project Lead e a OGNI ruolo di
-- progetto che conteneva già tutti i suoi permessi (la regola della 0135,
-- `docs/invariants/permissions.md`): prima i ruoli, poi il preset. Gli altri
-- preset e i ruoli personalizzati nascono SENZA; il full admin l'ha implicito.
UPDATE "roles" AS r
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest(r."permissions" || ARRAY['automations.manage']) AS p)
WHERE r."scope" = 'project'
	AND r."preset_key" IS DISTINCT FROM 'project_lead'
	AND r."permissions" @> (SELECT "permissions" FROM "roles" WHERE "preset_key" = 'project_lead');
--> statement-breakpoint
UPDATE "roles"
SET "permissions" = ARRAY(SELECT DISTINCT p FROM unnest("permissions" || ARRAY['automations.manage']) AS p)
WHERE "preset_key" = 'project_lead';
