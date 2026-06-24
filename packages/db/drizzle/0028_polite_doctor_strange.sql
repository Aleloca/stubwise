CREATE TABLE "doc_search_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"kind" "doc_page_kind" NOT NULL,
	"clicked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_search_history" ADD CONSTRAINT "doc_search_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_search_history" ADD CONSTRAINT "doc_search_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_search_history_user_project_slug_unique" ON "doc_search_history" USING btree ("user_id","project_id","slug");--> statement-breakpoint
CREATE INDEX "doc_search_history_recent_idx" ON "doc_search_history" USING btree ("user_id","project_id","clicked_at" DESC NULLS LAST);