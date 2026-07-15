CREATE TABLE "activity_day_rollups" (
	"date" date PRIMARY KEY NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_dev_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"user_id" uuid,
	"git_email" text,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_reports" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "activity_dev_summaries" ADD CONSTRAINT "activity_dev_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_dev_summaries_date_user_unique" ON "activity_dev_summaries" USING btree ("date","user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_dev_summaries_date_email_unique" ON "activity_dev_summaries" USING btree ("date","git_email") WHERE git_email is not null;--> statement-breakpoint
CREATE INDEX "activity_dev_summaries_date_idx" ON "activity_dev_summaries" USING btree ("date");