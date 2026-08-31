CREATE TYPE "public"."notification_kind" AS ENUM('ticket.created', 'job.pr_opened', 'job.pr_closed', 'job.held', 'job.plan_review', 'job.budget_held', 'review.completed', 'job.failed', 'docs.limit_paused', 'monitor.alert', 'monitor.recovered');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('open', 'handled', 'snoozed');--> statement-breakpoint
CREATE TYPE "public"."delivery_channel" AS ENUM('webhook', 'slack_dm', 'slack_update');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"ticket_id" uuid,
	"job_id" uuid,
	"kind" "notification_kind" NOT NULL,
	"event" jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'open' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"read_at" timestamp with time zone,
	"handled_at" timestamp with time zone,
	"handled_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid,
	"event" jsonb,
	"channel" "delivery_channel" NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_follows" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_follows_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD COLUMN "plan_approval_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_slack_dm" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_job_id_ai_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_handled_by_user_id_users_id_fk" FOREIGN KEY ("handled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_follows" ADD CONSTRAINT "project_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_follows" ADD CONSTRAINT "project_follows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Inbox di un utente: le notifiche ancora da smaltire, dalla più recente.
-- Indice PARZIALE su status = 'open': resta piccolo anche quando lo storico
-- delle notifiche gestite/rinviate cresce.
CREATE INDEX "notifications_user_open_idx" ON "notifications" USING btree ("user_id","created_at" DESC) WHERE status = 'open';--> statement-breakpoint
-- Fan-in dal job: da un evento si risale a tutti i destinatari avvisati (per
-- aggiornare in blocco le notifiche di un job che è stato risolto).
CREATE INDEX "notifications_job_id_idx" ON "notifications" USING btree ("job_id");--> statement-breakpoint
-- Claim dell'outbox: la prossima consegna dovuta. Indice parziale sugli invii
-- ancora in sospeso, quelli conclusi non partecipano.
CREATE INDEX "notification_deliveries_pending_idx" ON "notification_deliveries" USING btree ("next_attempt_at") WHERE status = 'pending';
