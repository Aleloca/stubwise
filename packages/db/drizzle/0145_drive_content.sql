-- Area 5, fetta 3 (11 nov 2026): il CONTENUTO dei file del Drive. Piano
-- `docs/plans/2026-11-11-integrazione-area5-fetta3-plan.md`. Il worker estrae
-- il testo (OCR compreso), scrive un riassunto (Haiku, `drive_summary`) e gli
-- embedding. Tutto additivo: le righe di oggi nascono `pending` e le prende il
-- poller del worker da sé.
ALTER TABLE "drive_files" ADD COLUMN "content_status" text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "content_reason" text;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "content_ocr" text;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "content_text" text;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "content_truncated" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "summary" text;
--> statement-breakpoint
ALTER TABLE "drive_files" ADD COLUMN "content_updated_at" timestamp with time zone;
--> statement-breakpoint
-- La ricerca testuale: nome (punti, trattini e _ come spazi: «fornitura.pdf» è
-- un token solo per il parser) + i primi 100.000 caratteri del testo, `simple`
-- (lingue miste). Il testo arriva a 1.000.000 di caratteri, che una tsvector
-- (al più 1 MB) non regge; oltre i 100.000 trova la corsia semantica dei chunk.
ALTER TABLE "drive_files" ADD COLUMN "content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', regexp_replace(coalesce("name", ''), '[._-]+', ' ', 'g') || ' ' || left(coalesce("content_text", ''), 100000))) STORED;
--> statement-breakpoint
CREATE INDEX "drive_files_content_tsv_idx" ON "drive_files" USING gin ("content_tsv");
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_content_status_chk" CHECK ("content_status" in ('pending', 'processing', 'ready', 'no_text', 'unsupported', 'error'));
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_content_reason_chk" CHECK ("content_reason" in ('no_text_found', 'ocr_timeout', 'ocr_unavailable', 'unreadable', 'too_large', 'limits'));
--> statement-breakpoint
-- `no_text` ha SEMPRE il suo motivo, e solo lui ne ha uno.
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_content_reason_status_chk" CHECK (("content_status" = 'no_text') = ("content_reason" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_content_ocr_chk" CHECK ("content_ocr" in ('none', 'full', 'partial'));
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_summary_len_chk" CHECK (char_length("summary") <= 600);
--> statement-breakpoint
-- I passaggi del testo con l'embedding (bge-m3, 1024), come `doc_chunks`.
-- La lapide non cancella la riga del file: i chunk li toglie l'UPDATE della
-- lapide, nella stessa transazione; la cascata copre l'eliminazione del progetto.
CREATE TABLE "drive_file_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024)
);
--> statement-breakpoint
ALTER TABLE "drive_file_chunks" ADD CONSTRAINT "drive_file_chunks_file_fk" FOREIGN KEY ("file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "drive_file_chunks_file_idx" ON "drive_file_chunks" USING btree ("file_id");
--> statement-breakpoint
CREATE INDEX "drive_file_chunks_embedding_idx" ON "drive_file_chunks" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
-- La coda del worker, col pattern di `graph_jobs` (FOR UPDATE SKIP LOCKED):
-- al più un job VIVO per file.
CREATE TABLE "drive_content_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_content_jobs_status_chk" CHECK ("status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "drive_content_jobs" ADD CONSTRAINT "drive_content_jobs_file_fk" FOREIGN KEY ("file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "drive_content_jobs_active_unique" ON "drive_content_jobs" USING btree ("file_id") WHERE "status" IN ('queued', 'running');
--> statement-breakpoint
-- L'operazione AI del riassunto: i due CHECK derivati da `AI_OPERATIONS`.
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_operation_chk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe'));
--> statement-breakpoint
ALTER TABLE "ai_model_settings" DROP CONSTRAINT "ai_model_settings_operation_chk";
--> statement-breakpoint
ALTER TABLE "ai_model_settings" ADD CONSTRAINT "ai_model_settings_operation_chk" CHECK (operation in ('triage', 'fix_plan', 'fix_execute', 'pr_review', 'summary', 'backlog_intake', 'backlog_refine', 'commit_summary', 'release_notes', 'docs_nightly', 'docs_generation', 'drive_summary', 'daily_report', 'weekly_brief', 'mail_classify', 'chat', 'claude_chat', 'backlog_merge', 'plugin_smoke', 'credential_test', 'usage_probe'));
