CREATE TYPE "public"."ai_job_status" AS ENUM('queued', 'triaging', 'fixing', 'pr_opened', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."comment_author_type" AS ENUM('user', 'ai');--> statement-breakpoint
CREATE TYPE "public"."git_provider_kind" AS ENUM('bitbucket', 'github');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."ticket_source" AS ENUM('manual', 'sdk_error', 'sdk_feedback', 'api');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'triaged', 'in_progress', 'in_review', 'done', 'closed');--> statement-breakpoint
CREATE TYPE "public"."ticket_type" AS ENUM('bug', 'feature', 'task', 'feedback');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"status" "ai_job_status" DEFAULT 'queued' NOT NULL,
	"log" text DEFAULT '' NOT NULL,
	"pr_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_type" "comment_author_type" NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"ticket_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"token" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"provider" "git_provider_kind" NOT NULL,
	"repo_url" text NOT NULL,
	"default_branch" text NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"ingestion_key" text NOT NULL,
	"next_ticket_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_ingestion_key_unique" UNIQUE("ingestion_key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"type" "ticket_type" NOT NULL,
	"priority" "ticket_priority" NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"source" "ticket_source" NOT NULL,
	"assignee_id" uuid,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"technical_payload" jsonb,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "error_groups_project_id_fingerprint_unique" ON "error_groups" USING btree ("project_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_project_id_number_unique" ON "tickets" USING btree ("project_id","number");