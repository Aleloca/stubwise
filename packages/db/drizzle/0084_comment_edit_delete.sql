ALTER TABLE "comments" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_deleted_body_empty_chk" CHECK ("deleted_at" IS NULL OR "body" = '');--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_deleted_by_requires_deleted_chk" CHECK ("deleted_by_user_id" IS NULL OR "deleted_at" IS NOT NULL);
