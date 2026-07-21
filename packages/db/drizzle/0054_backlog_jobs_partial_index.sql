DROP INDEX "backlog_jobs_status_idx";--> statement-breakpoint
CREATE INDEX "backlog_jobs_queued_created_at_idx" ON "backlog_jobs" USING btree ("created_at") WHERE status = 'queued';