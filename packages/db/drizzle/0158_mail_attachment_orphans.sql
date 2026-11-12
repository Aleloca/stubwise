-- Review della F3, punto 1: un allegato caricato dal disco che se ne va
-- (bozza mandata, eliminata, annullata con lo slot occupato, o la cascata da
-- casella o persona) lascia il suo oggetto fra gli orfani dello storage, NELLA
-- STESSA transazione: il purge orario del server lo toglie. Un trigger e non
-- il codice: le cascate non passano dal codice.
CREATE OR REPLACE FUNCTION "mail_draft_attachment_orphan"() RETURNS trigger AS $$
BEGIN
  IF OLD."storage_key" IS NOT NULL THEN
    INSERT INTO "storage_orphans" ("storage_key", "reason")
    VALUES (OLD."storage_key", 'mail_draft_attachment')
    ON CONFLICT ("storage_key") DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "mail_draft_attachments_orphan"
  BEFORE DELETE ON "mail_draft_attachments"
  FOR EACH ROW EXECUTE FUNCTION "mail_draft_attachment_orphan"();
