CREATE INDEX "ai_jobs_ticket_id_idx" ON "ai_jobs" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "ai_jobs_queued_created_at_idx" ON "ai_jobs" USING btree ("created_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "comments_ticket_id_idx" ON "comments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "error_groups_ticket_id_idx" ON "error_groups" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tickets_project_id_status_idx" ON "tickets" USING btree ("project_id","status");