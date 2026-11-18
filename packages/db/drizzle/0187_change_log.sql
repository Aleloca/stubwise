-- Area 9, F2 (D-3 = a, D-4 = a; docs/invariants/change-log.md): il registro
-- delle modifiche. Si scrive nella transazione della modifica
-- (`recordChange`), non si modifica né si cancella MAI, e si tiene per sempre.
-- `type` è testo: l'elenco chiuso vive in `@stubwise/shared`
-- (`CHANGE_LOG_TYPES`), come `security_events.kind`. `data` ha la forma del
-- prototipo (`object`, `before`, `after`, `params`), coi nomi fissati al
-- momento e MAI un segreto. `actor_email` resta anche quando l'utente
-- sparisce; `project_id` va a null col progetto, e la voce resta.
CREATE TABLE "change_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_email" text NOT NULL,
	"actor_kind" text NOT NULL,
	"type" text NOT NULL,
	"project_id" uuid,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "change_log_actor_kind_chk" CHECK ("actor_kind" IN ('user', 'agent', 'system'))
);
--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "change_log_at_idx" ON "change_log" USING btree ("at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "change_log_project_at_idx" ON "change_log" USING btree ("project_id", "at" DESC);
--> statement-breakpoint
CREATE INDEX "change_log_actor_at_idx" ON "change_log" USING btree ("actor_user_id", "at" DESC);
--> statement-breakpoint
CREATE INDEX "change_log_type_at_idx" ON "change_log" USING btree ("type", "at" DESC);
--> statement-breakpoint
-- Solo in aggiunta. Un UPDATE passa SOLO se l'unico cambio è il riferimento
-- all'attore o al progetto che va a NULL E viene dall'azione della FK (le
-- `ON DELETE SET NULL`, che Postgres esegue come UPDATE annidato in un suo
-- trigger: `pg_trigger_depth() > 1`). Un UPDATE a mano che azzera attore o
-- progetto per nascondere chi ha agito si rifiuta come gli altri.
CREATE FUNCTION "change_log_append_only"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE'
		AND pg_trigger_depth() > 1
		AND (NEW."id", NEW."at", NEW."actor_email", NEW."actor_kind", NEW."type", NEW."subject_kind", NEW."subject_id", NEW."data")
			IS NOT DISTINCT FROM (OLD."id", OLD."at", OLD."actor_email", OLD."actor_kind", OLD."type", OLD."subject_kind", OLD."subject_id", OLD."data")
		AND (NEW."actor_user_id" IS NOT DISTINCT FROM OLD."actor_user_id" OR NEW."actor_user_id" IS NULL)
		AND (NEW."project_id" IS NOT DISTINCT FROM OLD."project_id" OR NEW."project_id" IS NULL)
	THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'change_log is append-only (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "change_log_append_only_row" BEFORE UPDATE OR DELETE ON "change_log" FOR EACH ROW EXECUTE FUNCTION "change_log_append_only"();
--> statement-breakpoint
CREATE TRIGGER "change_log_append_only_truncate" BEFORE TRUNCATE ON "change_log" FOR EACH STATEMENT EXECUTE FUNCTION "change_log_append_only"();
