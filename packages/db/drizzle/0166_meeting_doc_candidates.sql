-- Area 6, review F5a, punto 2: i link ai Doc dell'email di Gemini sono
-- CANDIDATI (il primo trovato può venire dal titolo della riunione, che
-- sceglie l'organizzatore); il worker legge solo quello che VERIFICA su Drive.
ALTER TABLE "meeting_notes" ADD COLUMN "doc_candidates" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "meeting_notes" DROP CONSTRAINT "meeting_notes_doc_reason_chk";
--> statement-breakpoint
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_doc_reason_chk" CHECK (doc_reason is null or doc_reason in ('scope_missing', 'not_shared', 'deleted', 'too_long', 'not_verified'));
