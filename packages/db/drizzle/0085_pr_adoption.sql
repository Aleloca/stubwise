ALTER TABLE "ticket_repositories" ADD COLUMN "adopted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ticket_repositories" ADD COLUMN "adopted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_repositories" ADD COLUMN "adoption_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ticket_repositories" ADD COLUMN "adoption_released_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_repositories" ADD CONSTRAINT "ticket_repositories_adopted_by_user_id_users_id_fk" FOREIGN KEY ("adopted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_repositories" ADD CONSTRAINT "ticket_repositories_adoption_released_by_user_id_users_id_fk" FOREIGN KEY ("adoption_released_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_repositories" ADD CONSTRAINT "ticket_repositories_adoption_release_chk" CHECK ("adoption_released_at" IS NULL OR "adopted_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "pr_review_jobs" ADD COLUMN "from_fork" boolean;--> statement-breakpoint
ALTER TABLE "pr_reviews" ADD COLUMN "from_fork" boolean;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "protected_branches" text[] DEFAULT '{}' NOT NULL;
