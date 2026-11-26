-- Area 9, F7 (M-5 = a): il registro delle modifiche sa che una voce l'ha
-- scritta Claude, e quale azione di Claude una voce annulla.
-- `via_claude_action_id` prende di DEFAULT la stessa variabile di
-- transazione delle task e dei commenti (`stubwise.via_claude_action_id`,
-- 0131), che SOLO l'esecutore delle azioni di Claude imposta;
-- `undo_of_action_id` la variabile nuova `stubwise.undo_of_claude_action_id`,
-- che l'esecutore imposta per l'inverso di un «Annulla» (l'azione annullata).
-- Senza FK: il trigger append-only lascia passare solo le `SET NULL` delle
-- FK di attore e progetto, e un'azione di Claude non si cancella comunque.
-- Le voci di prima restano a null: non si sa più chi le ha scritte.
ALTER TABLE "change_log" ADD COLUMN "via_claude_action_id" uuid DEFAULT nullif(current_setting('stubwise.via_claude_action_id', true), '')::uuid;
--> statement-breakpoint
ALTER TABLE "change_log" ADD COLUMN "undo_of_action_id" uuid DEFAULT nullif(current_setting('stubwise.undo_of_claude_action_id', true), '')::uuid;
--> statement-breakpoint
CREATE INDEX "change_log_via_claude_idx" ON "change_log" USING btree ("via_claude_action_id") WHERE "via_claude_action_id" IS NOT NULL;
--> statement-breakpoint
-- Le due colonne nuove entrano nella tupla che un UPDATE annidato (l'azione
-- di una FK) non può cambiare: senza, quel ramo lascerebbe riscrivere chi
-- l'ha scritta.
CREATE OR REPLACE FUNCTION "change_log_append_only"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE'
		AND pg_trigger_depth() > 1
		AND (NEW."id", NEW."at", NEW."actor_email", NEW."actor_kind", NEW."type", NEW."subject_kind", NEW."subject_id", NEW."data", NEW."via_claude_action_id", NEW."undo_of_action_id")
			IS NOT DISTINCT FROM (OLD."id", OLD."at", OLD."actor_email", OLD."actor_kind", OLD."type", OLD."subject_kind", OLD."subject_id", OLD."data", OLD."via_claude_action_id", OLD."undo_of_action_id")
		AND (NEW."actor_user_id" IS NOT DISTINCT FROM OLD."actor_user_id" OR NEW."actor_user_id" IS NULL)
		AND (NEW."project_id" IS NOT DISTINCT FROM OLD."project_id" OR NEW."project_id" IS NULL)
	THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'change_log is append-only (%)', TG_OP;
END;
$$ LANGUAGE plpgsql;
