ALTER TABLE "projects" RENAME COLUMN "doc_auto_update_provider_id" TO "ai_provider_id";--> statement-breakpoint
ALTER TABLE "doc_generation_jobs" DROP CONSTRAINT "doc_generation_jobs_pinned_provider_id_ai_providers_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_doc_auto_update_provider_id_ai_providers_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_ai_provider_id_ai_providers_id_fk" FOREIGN KEY ("ai_provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_generation_jobs" DROP COLUMN "pinned_provider_id";