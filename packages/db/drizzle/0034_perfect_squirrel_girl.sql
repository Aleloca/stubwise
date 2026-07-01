-- Fase 2 multi-repo: sessioni di chat doc a DUE livelli (repo o progetto).
-- Additiva e non distruttiva: repository_id diventa nullable, nasce project_id
-- nullable (FK projects, cascade), un CHECK impone l'XOR (esattamente uno dei due
-- valorizzato) e un indice copre il lookup per progetto. Le righe esistenti sono
-- tutte repo-level (project_id NULL, repository_id valorizzato) e soddisfano il
-- CHECK senza backfill.
ALTER TABLE "doc_chat_sessions" ALTER COLUMN "repository_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_chat_sessions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "doc_chat_sessions" ADD CONSTRAINT "doc_chat_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_chat_sessions_project_id_idx" ON "doc_chat_sessions" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "doc_chat_sessions" ADD CONSTRAINT "doc_chat_sessions_scope_chk" CHECK (("repository_id" IS NOT NULL) <> ("project_id" IS NOT NULL));