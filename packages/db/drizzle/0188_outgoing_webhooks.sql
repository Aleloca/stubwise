-- Area 9, F3 (D-10 = b; docs/plans/2026-11-18-integrazione-area9-f3-plan.md):
-- più webhook in uscita, ognuno con URL, formato, eventi scelti e segreto suoi.
-- Un webhook non riceve mai un evento che non ha scelto: le consegne sono una
-- PER WEBHOOK (`notification_deliveries.webhook_id`). Il catalogo dei 21 eventi
-- vive in `@stubwise/shared` (OUTGOING_WEBHOOK_EVENTS), e il CHECK lo ricopia:
-- un test di parità li tiene allineati. Il tetto di 20 lo tiene il servizio.
CREATE TABLE "outgoing_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"format" "notification_format" DEFAULT 'slack' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"secret_encrypted" text,
	"secret_rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	CONSTRAINT "outgoing_webhooks_events_chk" CHECK ("events" <@ ARRAY['ticket.created','task.created_by_automation','support.request','job.plan_review','job.awaiting_input','job.held','job.budget_held','job.failed','job.pr_opened','job.pr_closed','review.completed','pr.analysis_issues','release.merged','release.succeeded','release.failed','docs.limit_paused','docs.release_note','monitor','server.diagnosis_ready','project.pulse','project.brief']::text[])
);
--> statement-breakpoint
ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "outgoing_webhooks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "webhook_id" uuid;
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_webhook_id_outgoing_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."outgoing_webhooks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Il webhook di oggi diventa il primo, se c'era un URL e la tabella è vuota.
-- Gli eventi: quelli dei `notify_*` accesi (la mappa del catalogo). Il
-- segreto nasce NULLO: la migrazione non ha ENCRYPTION_KEY; finché non lo si
-- rigenera, gli invii di questo webhook partono senza firma, come prima.
-- `notification_settings` resta, senza più letture del nuovo codice.
INSERT INTO "outgoing_webhooks" ("name", "url", "format", "enabled", "events")
SELECT 'Webhook', ns."webhook_url", ns."format", ns."enabled",
	ARRAY(SELECT e FROM unnest(ARRAY[
		CASE WHEN ns."notify_ticket_created" THEN 'ticket.created' END,
		CASE WHEN ns."notify_plan_review" THEN 'job.plan_review' END,
		CASE WHEN ns."notify_awaiting_input" THEN 'job.awaiting_input' END,
		CASE WHEN ns."notify_job_held" THEN 'job.held' END,
		CASE WHEN ns."notify_budget_held" THEN 'job.budget_held' END,
		CASE WHEN ns."notify_job_failed" THEN 'job.failed' END,
		CASE WHEN ns."notify_pr_opened" THEN 'job.pr_opened' END,
		CASE WHEN ns."notify_pr_closed" THEN 'job.pr_closed' END,
		CASE WHEN ns."notify_review_completed" THEN 'review.completed' END,
		CASE WHEN ns."notify_docs_limit_paused" THEN 'docs.limit_paused' END,
		CASE WHEN ns."notify_monitor" THEN 'monitor' END,
		CASE WHEN ns."notify_pulse" THEN 'project.pulse' END,
		CASE WHEN ns."notify_brief" THEN 'project.brief' END
	]) AS e WHERE e IS NOT NULL)
FROM "notification_settings" ns
WHERE ns."webhook_url" IS NOT NULL AND ns."webhook_url" <> ''
	AND NOT EXISTS (SELECT 1 FROM "outgoing_webhooks")
ORDER BY ns."id"
LIMIT 1;
