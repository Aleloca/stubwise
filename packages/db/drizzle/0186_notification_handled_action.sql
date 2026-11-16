-- Area 9, F1, review (I3, decisione del maintainer): COME è stata chiusa una
-- card. `archive` = l'ha archiviata il destinatario (igiene personale), e solo
-- quella si può ripristinare; `decision` = l'ha chiusa una decisione (sua o di
-- un altro, anche su una copia già archiviata). NULL = chiusa prima di questa
-- migrazione o da un altro scrittore: non si ripristina (409 invalid_state).
-- Additiva, nullable: il codice di prima la ignora.
ALTER TABLE "notifications" ADD COLUMN "handled_action" text;
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_handled_action_chk" CHECK ("handled_action" IS NULL OR "handled_action" IN ('archive', 'decision'));
