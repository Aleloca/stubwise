CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."doc_generation_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."doc_generation_trigger" AS ENUM('manual', 'push');--> statement-breakpoint
CREATE TYPE "public"."doc_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'held');--> statement-breakpoint
CREATE TYPE "public"."doc_page_kind" AS ENUM('technical', 'functional', 'manual');--> statement-breakpoint
CREATE TABLE "doc_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"generation_id" uuid,
	"content" text NOT NULL,
	"embedding" vector(1024),
	"metadata" jsonb,
	"token_count" integer
);
--> statement-breakpoint
CREATE TABLE "doc_generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"generation_id" uuid,
	"status" "doc_job_status" DEFAULT 'queued' NOT NULL,
	"trigger" "doc_generation_trigger" DEFAULT 'manual' NOT NULL,
	"log" text DEFAULT '' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "doc_generation_status" DEFAULT 'pending' NOT NULL,
	"commit_sha" text,
	"trigger" "doc_generation_trigger" DEFAULT 'manual' NOT NULL,
	"model" text,
	"cost" numeric(12, 6),
	"stats" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"generation_id" uuid,
	"kind" "doc_page_kind" NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"parent_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"source_path" text,
	"body" text DEFAULT '' NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("doc_pages"."title", '') || ' ' || coalesce("doc_pages"."body", ''))) STORED
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "current_doc_generation_id" uuid;--> statement-breakpoint
ALTER TABLE "doc_chat_messages" ADD CONSTRAINT "doc_chat_messages_session_id_doc_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."doc_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_chat_sessions" ADD CONSTRAINT "doc_chat_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_chat_sessions" ADD CONSTRAINT "doc_chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_chunks" ADD CONSTRAINT "doc_chunks_page_id_doc_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."doc_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_chunks" ADD CONSTRAINT "doc_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_chunks" ADD CONSTRAINT "doc_chunks_generation_id_doc_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."doc_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_generation_jobs" ADD CONSTRAINT "doc_generation_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_generation_jobs" ADD CONSTRAINT "doc_generation_jobs_generation_id_doc_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."doc_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_generations" ADD CONSTRAINT "doc_generations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_pages" ADD CONSTRAINT "doc_pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_pages" ADD CONSTRAINT "doc_pages_generation_id_doc_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."doc_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_pages" ADD CONSTRAINT "doc_pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_chat_messages_session_idx" ON "doc_chat_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "doc_chat_sessions_project_idx" ON "doc_chat_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "doc_chunks_project_idx" ON "doc_chunks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "doc_generation_jobs_status_idx" ON "doc_generation_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "doc_generation_jobs_project_idx" ON "doc_generation_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "doc_generations_project_idx" ON "doc_generations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "doc_pages_project_idx" ON "doc_pages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "doc_pages_generation_idx" ON "doc_pages" USING btree ("generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_pages_project_slug_unique" ON "doc_pages" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "doc_pages_search_tsv_idx" ON "doc_pages" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX doc_chunks_embedding_idx ON doc_chunks USING hnsw (embedding vector_cosine_ops);