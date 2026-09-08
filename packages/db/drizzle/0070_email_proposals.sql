-- Fase 6b — proposte email per progetto. Tutto additivo, nessun valore di
-- enum nuovo, quindi un solo batch (a differenza della 0069): colonna nuova
-- su `email_messages`, una tabella nuova `email_proposals`, e un backfill dei
-- dati esistenti in fondo, nella STESSA transazione del migratore.
--
-- Il problema che risolve: fino ad oggi un messaggio email risolveva a UN
-- progetto (`email_messages.project_id`) e la sua unica classificazione era
-- quella di quel progetto. `email_proposals` è la riga FIGLIA per-progetto:
-- una email che tocca più progetti (il routing non decide, o riguarda più
-- team) ora produce una proposta per ciascuno, indipendente dalle altre.
-- `email_messages` resta il messaggio grezzo e la sua colonna `classification`
-- non cambia significato: è ancora l'esito legacy a un solo progetto.

-- `scopeProjectIds` è l'insieme COMPLETO dei progetti a cui il messaggio è
-- visibile: `project_id` (il risolto) più ogni `candidate_project_ids` che non
-- ha vinto il routing. È la lista su cui si costruiscono le `email_proposals`
-- — vedi il backfill in fondo.
ALTER TABLE "email_messages" ADD COLUMN "scope_project_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Una proposta di UN messaggio per UN progetto. `classification` è NOT NULL
-- qui (a differenza di quella, nullable, di `email_messages`): una riga
-- esiste solo quando la classificazione per QUEL progetto è già stata
-- prodotta. Il cascade su entrambe le FK segue lo stesso principio della
-- tabella madre: cancellare il messaggio o il progetto non deve lasciare
-- proposte orfane.
CREATE TABLE "email_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_message_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'classified' NOT NULL,
	"classification" jsonb NOT NULL,
	"proposal_notification_id" uuid,
	"outcome" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_proposals_email_message_id_project_id_unique" UNIQUE("email_message_id","project_id"),
	CONSTRAINT "email_proposals_status_chk" CHECK ("status" in ('classified', 'proposed', 'actioned', 'ignored', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "email_proposals" ADD CONSTRAINT "email_proposals_email_message_id_email_messages_id_fk" FOREIGN KEY ("email_message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_proposals" ADD CONSTRAINT "email_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_proposals" ADD CONSTRAINT "email_proposals_proposal_notification_id_notifications_id_fk" FOREIGN KEY ("proposal_notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Claim di una proposta non ancora pubblicata: le sole righe classificate e
-- senza notifica sono candidate al prossimo giro del poller. Parziale, come
-- l'analogo claim su `email_messages` prima della fase 6b: un progetto alla
-- volta, non l'intera coda.
CREATE INDEX "email_proposals_claim_idx" ON "email_proposals" USING btree ("email_message_id") WHERE status = 'classified' and proposal_notification_id is null;--> statement-breakpoint

-- Backfill 1/2: righe figlie per i messaggi già classificati o proposti PRIMA
-- di questa migrazione. Ereditano classification/status/proposal_notification_id
-- dal messaggio, per il suo `project_id` (il progetto risolto — i soli che
-- hanno una classificazione già prodotta ad oggi, dato che finora un
-- messaggio ne aveva al più una).
--
-- `AND classification IS NOT NULL` è difensivo: la colonna è nullable su
-- `email_messages` e `email_proposals.classification` è NOT NULL, quindi una
-- riga incoerente (status classified/proposed ma senza classification)
-- romperebbe l'insert. Nel codice applicativo (worker, fase 6) lo stato passa
-- a 'classified' nella STESSA UPDATE che scrive `classification`, quindi il
-- caso non si presenta ad oggi — ma il backfill non lo assume: se dovesse
-- capitare, quella riga resta senza proposta figlia invece di far fallire
-- l'intera migrazione.
INSERT INTO "email_proposals" ("email_message_id", "project_id", "status", "classification", "proposal_notification_id")
SELECT "id", "project_id", "status", "classification", "proposal_notification_id"
FROM "email_messages"
WHERE "status" IN ('classified', 'proposed')
  AND "project_id" IS NOT NULL
  AND "classification" IS NOT NULL;
--> statement-breakpoint

-- Backfill 2/2: `scope_project_ids` per TUTTE le righe esistenti (non solo
-- quelle diventate figlie sopra) — il progetto risolto più i candidati che non
-- hanno vinto il routing, senza NULL (`project_id` può essere null; niente
-- dedup — `candidate_project_ids` non contiene mai `project_id`, sono
-- alternative scartate dal routing, non l'esito). La guardia
-- `WHERE scope_project_ids = '{}'` è ridondante appena dopo l'ALTER (ogni riga
-- parte dal default `'{}'`), ma rende lo statement idempotente se mai
-- rieseguito a mano.
UPDATE "email_messages"
SET "scope_project_ids" = array_remove(ARRAY["project_id"] || "candidate_project_ids", NULL)
WHERE "scope_project_ids" = '{}';
