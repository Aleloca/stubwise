ALTER TYPE "public"."doc_page_kind" ADD VALUE 'releases';--> statement-breakpoint
CREATE TABLE "doc_auto_update_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_sha" text NOT NULL,
	"to_sha" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "doc_auto_update" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "doc_auto_update_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "doc_auto_update_jobs" ADD CONSTRAINT "doc_auto_update_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_auto_update_jobs_project_unique" ON "doc_auto_update_jobs" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_doc_auto_update_provider_id_ai_providers_id_fk" FOREIGN KEY ("doc_auto_update_provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;