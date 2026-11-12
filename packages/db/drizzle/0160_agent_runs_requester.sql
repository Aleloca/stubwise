-- Review della F3, punto 8: chi ha chiesto una chiamata diretta del server
-- (chat, bozza di Claude), per il tetto giornaliero per persona.
ALTER TABLE "agent_runs" ADD COLUMN "requested_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_runs_requester_operation_idx" ON "agent_runs" USING btree ("requested_by_user_id", "operation", "created_at");
