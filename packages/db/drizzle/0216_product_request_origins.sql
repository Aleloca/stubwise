-- Area 11, F6: la pagina (e la frase) da cui nasce una richiesta: una voce
-- proposta dalla pagina («Turn into backlog items») o «Open a request» di una
-- domanda di Claude. Una riga per lavoro d'intake (la richiesta è
-- `backlog_jobs.result_item_id`, anche quando l'intake la fonde in una che c'è
-- già). L'ancora è null se la frase non c'è più: l'origine resta sulla
-- pagina. `productOrigin` di richieste e task si DERIVA da qui a lettura.
CREATE TABLE "product_request_origins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"page_id" uuid NOT NULL REFERENCES "product_pages"("id") ON DELETE CASCADE,
	"anchor_id" text,
	"question_id" uuid REFERENCES "product_comments"("id") ON DELETE SET NULL,
	"intake_job_id" uuid NOT NULL REFERENCES "backlog_jobs"("id") ON DELETE CASCADE,
	"created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_request_origins_job_key" UNIQUE ("intake_job_id")
);
--> statement-breakpoint
CREATE INDEX "product_request_origins_page_anchor_idx" ON "product_request_origins" ("page_id", "anchor_id");
