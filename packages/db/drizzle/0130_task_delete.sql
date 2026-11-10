-- «Elimina task» (chat con Claude, fetta 3.0, decisione del maintainer del 10
-- nov 2026; regole del prototipo in apps/desktop/.impeccable/shape/task-delete.md).
-- Un'eliminazione VERA: la riga di `tickets` se ne va. Ogni FK verso `tickets`
-- è decisa (motivi nel commento di `deletedTickets` in schema.ts):
--   * se ne va con la task (CASCADE, invariato): follower, richieste di
--     decisione, gruppi d'errore, repository e PR del ticket, commenti, storia
--     (`ticket_events`), collegamenti in entrambi i versi, job (`ai_jobs`),
--     allegati, correzioni (chiuse: una aperta impedisce l'eliminazione),
--     legame con la richiesta, domande, sessioni dell'agente, accordi della
--     giornata;
--   * resta col riferimento nullo (SET NULL, già così): review delle PR,
--     messaggi del widget, registro decisioni;
--   * QUI passano a SET NULL: le notifiche (sono di chi le riceve: restano,
--     e «task eliminata» si deriva a lettura) e i consumi (`agent_runs.job_id`:
--     il costo resta quando il job se ne va).
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_ticket_id_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_job_id_ai_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_job_id_ai_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_job_id_ai_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_job_id_ai_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- La LAPIDE: ciò che resta di una task eliminata, perché chi la nominava lo
-- dica («La task MKX-31 è stata eliminata»). Codice (progetto + numero),
-- titolo (lo standup e il registro lo nominano), la richiesta d'origine, chi e
-- quando, e il segno «via Claude». NIENTE descrizione, commenti, allegati né
-- storia: se ne vanno con la task. L'id è quello della task: un riferimento
-- rimasto nei payload si risolve qui.
CREATE TABLE "deleted_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"origin_backlog_item_id" uuid,
	"deleted_by" uuid,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"via_claude_action_id" uuid,
	CONSTRAINT "deleted_tickets_project_number_unique" UNIQUE("project_id","number")
);
--> statement-breakpoint
ALTER TABLE "deleted_tickets" ADD CONSTRAINT "deleted_tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deleted_tickets" ADD CONSTRAINT "deleted_tickets_origin_backlog_item_id_backlog_items_id_fk" FOREIGN KEY ("origin_backlog_item_id") REFERENCES "public"."backlog_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deleted_tickets" ADD CONSTRAINT "deleted_tickets_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "deleted_tickets_origin_idx" ON "deleted_tickets" USING btree ("origin_backlog_item_id");
